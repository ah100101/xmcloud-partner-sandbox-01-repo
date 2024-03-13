import regexParser from 'regex-parser';
import { NextResponse, NextRequest } from 'next/server';
import {
  RedirectInfo,
  REDIRECT_TYPE_301,
  REDIRECT_TYPE_302,
  REDIRECT_TYPE_SERVER_TRANSFER,
  SiteInfo,
} from '@sitecore-jss/sitecore-jss/site';
import { debug } from '@sitecore-jss/sitecore-jss';
import { get } from '@vercel/edge-config';
import {
  RedirectsMiddleware,
  RedirectsMiddlewareConfig,
} from '@sitecore-jss/sitecore-jss-nextjs/middleware';

const REGEXP_CONTEXT_SITE_LANG = new RegExp(/\$siteLang/, 'i');
const REGEXP_ABSOLUTE_URL = new RegExp('^(?:[a-z]+:)?//', 'i');

export class EdgeConfigRedirectsMiddleware extends RedirectsMiddleware {
  private regions: string[];

  /**
   * @param {RedirectsMiddlewareConfig} [config] redirects middleware config
   */
  constructor(protected config: RedirectsMiddlewareConfig) {
    super(config);
    this.regions = config.locales;
  }

  /**
   * Gets the Next.js middleware handler with error handling
   * @returns route handler
   */
  public getHandler(): (req: NextRequest, res?: NextResponse) => Promise<NextResponse> {
    return async (req, res) => {
      try {
        return await this.edgeConfigHandler(req, res);
      } catch (error) {
        console.log('Redirect middleware failed:');
        console.log(error);
        return res || NextResponse.next();
      }
    };
  }

  private edgeConfigHandler = async (
    req: NextRequest,
    res?: NextResponse
  ): Promise<NextResponse> => {
    const pathname = req.nextUrl.pathname;
    const language = this.getLanguage(req);
    const hostname = this.getHostHeader(req) || this.defaultHostname;
    let site: SiteInfo | undefined;
    const startTimestamp = Date.now();

    debug.redirects('redirects middleware start: %o', {
      pathname,
      language,
      hostname,
    });

    const createResponse = async () => {
      if (this.config.disabled && this.config.disabled(req, res || NextResponse.next())) {
        debug.redirects('skipped (redirects middleware is disabled)');
        return res || NextResponse.next();
      }

      if (this.isPreview(req) || this.excludeRoute(pathname)) {
        debug.redirects('skipped (%s)', this.isPreview(req) ? 'preview' : 'route excluded');

        return res || NextResponse.next();
      }

      site = this.getSite(req, res);

      // Find the redirect from result of RedirectService
      const existsRedirect = await this.getRedirects(req, site.name);

      if (!existsRedirect) {
        debug.redirects('skipped (redirect does not exist)');

        return res || NextResponse.next();
      }

      // Find context site language and replace token
      if (
        REGEXP_CONTEXT_SITE_LANG.test(existsRedirect.target) &&
        !(
          REGEXP_ABSOLUTE_URL.test(existsRedirect.target) &&
          existsRedirect.target.includes(hostname)
        )
      ) {
        existsRedirect.target = existsRedirect.target.replace(
          REGEXP_CONTEXT_SITE_LANG,
          site.language
        );
      }

      const url = req.nextUrl.clone();

      if (REGEXP_ABSOLUTE_URL.test(existsRedirect.target)) {
        url.href = existsRedirect.target;
      } else {
        const source = `${url.pathname}${url.search}`;
        url.search = existsRedirect.isQueryStringPreserved ? url.search : '';
        const urlFirstPart = existsRedirect.target.split('/')[1];
        if (this.regions.includes(urlFirstPart)) {
          url.locale = urlFirstPart;
          existsRedirect.target = existsRedirect.target.replace(`/${urlFirstPart}`, '');
        }

        const target = source
          .replace(regexParser(existsRedirect.pattern), existsRedirect.target)
          .replace(/^\/\//, '/')
          .split('?');
        url.pathname = target[0];
        if (target[1]) {
          const newParams = new URLSearchParams(target[1]);
          for (const [key, val] of newParams.entries()) {
            url.searchParams.append(key, val);
          }
        }
      }

      const redirectUrl = decodeURIComponent(url.href);

      /** return Response redirect with http code of redirect type **/
      switch (existsRedirect.redirectType) {
        case REDIRECT_TYPE_301:
          return NextResponse.redirect(redirectUrl, {
            status: 301,
            statusText: 'Moved Permanently',
            headers: res?.headers,
          });
        case REDIRECT_TYPE_302:
          return NextResponse.redirect(redirectUrl, {
            status: 302,
            statusText: 'Found',
            headers: res?.headers,
          });
        case REDIRECT_TYPE_SERVER_TRANSFER:
          return NextResponse.rewrite(redirectUrl, res);
        default:
          return res || NextResponse.next();
      }
    };

    const response = await createResponse();

    debug.redirects('redirects middleware end in %dms: %o', Date.now() - startTimestamp, {
      redirected: response.redirected,
      status: response.status,
      url: response.url,
      headers: this.extractDebugHeaders(response.headers),
    });

    return response;
  };

  /**
   * Method returns RedirectInfo when matches
   * @param {NextRequest} req request
   * @param {string} siteName site name
   * @returns Promise<RedirectInfo | undefined>
   * @private
   */
  private async getRedirects(
    req: NextRequest,
    siteName: string
  ): Promise<RedirectInfo | undefined> {
    // call Vercel Edge Config for redirects by the JSS app name
    const redirectsJson = await get<string>(siteName);
    const redirects = redirectsJson && (JSON.parse(redirectsJson) as RedirectInfo[]);
    if (!redirects || redirects?.length == 0) return undefined;

    const tragetURL = req.nextUrl.pathname;
    const targetQS = req.nextUrl.search || '';
    const language = this.getLanguage(req);
    const modifyRedirects = structuredClone(redirects);

    return modifyRedirects.length
      ? modifyRedirects.find((redirect: RedirectInfo) => {
          redirect.pattern = redirect.pattern.replace(RegExp(`^[^]?/${language}/`, 'gi'), '');
          redirect.pattern = `/^\/${redirect.pattern
            .replace(/^\/|\/$/g, '')
            .replace(/^\^\/|\/\$$/g, '')
            .replace(/^\^|\$$/g, '')
            .replace(/(?<!\\)\?/g, '\\?')
            .replace(/\$\/gi$/g, '')}[\/]?$/gi`;

          return (
            (regexParser(redirect.pattern).test(tragetURL) ||
              regexParser(redirect.pattern).test(`${tragetURL}${targetQS}`) ||
              regexParser(redirect.pattern).test(`/${req.nextUrl.locale}${tragetURL}`) ||
              regexParser(redirect.pattern).test(
                `/${req.nextUrl.locale}${tragetURL}${targetQS}`
              )) &&
            (redirect.locale
              ? redirect.locale.toLowerCase() === req.nextUrl.locale.toLowerCase()
              : true)
          );
        })
      : undefined;
  }
}
