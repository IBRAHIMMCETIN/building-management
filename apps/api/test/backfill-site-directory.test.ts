import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';
import { beforeEach, describe, expect, it } from 'vitest';
import { backfillSiteDirectory } from '../scripts/backfill-site-directory.js';

const ddb = mockClient(DynamoDBDocumentClient);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-north-1', credentials: { accessKeyId: 'x', secretAccessKey: 'x' } }));
const quiet = { info: () => {} };

describe('site dizini doldurma betigi', () => {
  beforeEach(() => ddb.reset());

  it('dizinde olmayan siteleri sayfalayarak bulur ve yalnizca GSI1 anahtarlarini ekler', async () => {
    ddb
      .on(ScanCommand)
      .resolvesOnce({ Items: [{ PK: 'APT#a', SK: 'SITE', siteId: 'a' }], LastEvaluatedKey: { PK: 'x' } })
      .resolvesOnce({ Items: [{ PK: 'APT#b', SK: 'SITE', siteId: 'b' }] });
    ddb.on(UpdateCommand).resolvesOnce({}).rejectsOnce(new ConditionalCheckFailedException({ message: 'x', $metadata: {} }));

    const r = await backfillSiteDirectory({ client, tableName: 't', log: quiet });

    expect(r).toEqual({ found: 2, added: 1, alreadyListed: 1 });
    const scan = ddb.commandCalls(ScanCommand);
    expect(scan[0]!.args[0].input.ExpressionAttributeValues).toEqual({ ':site': 'SITE', ':dir': 'SITE_DIRECTORY' });
    expect(scan[1]!.args[0].input.ExclusiveStartKey).toEqual({ PK: 'x' });
    expect(ddb.commandCalls(UpdateCommand)[0]!.args[0].input).toMatchObject({
      Key: { PK: 'APT#a', SK: 'SITE' },
      UpdateExpression: 'SET GSI1PK = :pk, GSI1SK = :sk',
      ExpressionAttributeValues: { ':pk': 'SITE_DIRECTORY', ':sk': 'SITE#a' },
    });
  });

  it('dry-run hicbir sey yazmaz', async () => {
    ddb.on(ScanCommand).resolves({ Items: [{ PK: 'APT#a', SK: 'SITE', siteId: 'a' }] });
    expect(await backfillSiteDirectory({ client, tableName: 't', log: quiet }, { dryRun: true })).toEqual({ found: 1, added: 0, alreadyListed: 0 });
    expect(ddb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});
