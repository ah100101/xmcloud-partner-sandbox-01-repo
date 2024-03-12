import { NextApiRequest, NextApiResponse } from 'next';
import clientFactory from 'lib/graphql-client-factory';
import { siteResolver } from 'lib/site-resolver';
import { GraphQLRedirectsService } from '@sitecore-jss/sitecore-jss/site';

export default async function handler(_request: NextApiRequest, response: NextApiResponse) {
  if (
    !process.env.JSS_APP_NAME ||
    !process.env.EDGE_CONFIG_ENDPOINT ||
    !process.env.EDGE_CONFIG_VERCEL_TOKEN
  ) {
    return response
      .status(500)
      .json({ error: 'Environment variables for Edge Config redirects are not set' });
  }

  const config = {
    clientFactory,
    locales: ['en'],
    excludeRoute: () => false,
    disabled: () => process.env.NODE_ENV === 'development',
    siteResolver,
  };
  const redirectsService = new GraphQLRedirectsService({ ...config, fetch: fetch });
  const redirects = await redirectsService.fetchRedirects(process.env.JSS_APP_NAME);

  if (redirects.length === 0) response.status(200).send({ message: 'No redirects present' });

  const items = [
    {
      operation: 'upsert',
      key: process.env.JSS_APP_NAME,
      value: JSON.stringify(redirects),
    },
  ];

  try {
    const updateEdgeConfig = await fetch(`${process.env.EDGE_CONFIG_ENDPOINT}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${process.env.EDGE_CONFIG_VERCEL_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        items,
      }),
    });

    const result = await updateEdgeConfig.json();
    return response.status(200).send(result);
  } catch (error) {
    console.error(error);
    response.status(500).json({ error: 'Error updating Edge Config' });
  }
}
