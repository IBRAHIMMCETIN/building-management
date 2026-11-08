/**
 * Gelistirme veritabanini hazirlar: Terraform ile ayni sema (infra/dynamodb.tf) + mock
 * kullanicinin apartmani (`apt-dev-1`) ve iki blok. Tekrar calistirilabilir; var olani atlar.
 *
 * Iki hedef:
 *  - AWS (onerilen): DYNAMODB_ENDPOINT verilmez; tablo adi `-local` ile bitmek ZORUNDA.
 *    Boylece Terraform'un yonettigi tablolara (building-management-dev/prod) asla dokunulmaz.
 *    Kimlik: `aws login` ile konsol oturumu (README > Yerel Gelistirme).
 *  - DynamoDB Local: DYNAMODB_ENDPOINT=http://localhost:8000 (Docker/Java ile resmi emulator).
 *    Not: dynalite gibi emulatorler TransactWriteItems desteklemez; finans defteri calismaz.
 *
 *   npm run db:init
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  ResourceInUseException,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { getDynamo } from '../src/config/dynamodb.js';
import { coreRepository } from '../src/modules/core/repository.js';
import { createCoreService } from '../src/modules/core/service.js';

const endpoint = process.env.DYNAMODB_ENDPOINT;
const tableName = process.env.DYNAMODB_TABLE_NAME ?? 'building-management-local';
const region = process.env.AWS_REGION ?? 'eu-north-1';
const APARTMENT_ID = process.env.MOCK_APARTMENT_ID ?? 'apt-dev-1';
const ACTOR = 'local-db-script';

if (endpoint) {
  if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(endpoint)) {
    console.error('DYNAMODB_ENDPOINT yalnizca yerel bir adres olabilir (ornek: http://localhost:8000).');
    process.exit(1);
  }
  // DynamoDB Local kimlik dogrulamaz; gercek anahtarlarin gonderilmemesi icin sahte deger.
  process.env.AWS_ACCESS_KEY_ID = 'local';
  process.env.AWS_SECRET_ACCESS_KEY = 'local';
  delete process.env.AWS_PROFILE;
} else if (!tableName.endsWith('-local')) {
  console.error(
    `Guvenlik: AWS'de yalnizca adi "-local" ile biten tablo hazirlanir (verilen: ${tableName}).\n` +
      'Terraform tablolarina (building-management-dev/prod) bu betik dokunmaz.',
  );
  process.exit(1);
}
process.env.DYNAMODB_TABLE_NAME = tableName;
process.env.AWS_REGION = region;
console.log(`Hedef: ${endpoint ?? `AWS ${region}`} / tablo ${tableName}`);

async function ensureTable() {
  const client = new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) });
  try {
    await client.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'PK', AttributeType: 'S' },
          { AttributeName: 'SK', AttributeType: 'S' },
          { AttributeName: 'GSI1PK', AttributeType: 'S' },
          { AttributeName: 'GSI1SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
    console.log(`Tablo olusturuldu: ${tableName}`);
  } catch (err) {
    if (!(err instanceof ResourceInUseException)) throw err;
    console.log(`Tablo zaten var: ${tableName}`);
  }
  // Tablo olusturma asenkron: ACTIVE olmadan yazilan kayitlar ResourceNotFound alir.
  await waitUntilTableExists({ client, maxWaitTime: 60, minDelay: 1 }, { TableName: tableName });
  const { Table } = await client.send(new DescribeTableCommand({ TableName: tableName }));
  console.log(`Tablo durumu: ${Table?.TableStatus}`);
}

async function ensureSite() {
  if (await coreRepository.getSite(APARTMENT_ID)) {
    console.log(`Site zaten var: ${APARTMENT_ID}`);
    return;
  }
  // Mock kullanicinin token'indaki apartmanla eslesmesi icin sabit kimlik.
  const core = createCoreService({ newId: () => APARTMENT_ID });
  await core.createSite(ACTOR, 'tenant-dev', {
    name: 'Geliştirme Sitesi',
    type: 'site',
    address: { line1: 'Örnek Mah. Deneme Sok. No:1', district: 'Kadıköy', city: 'İstanbul' },
  });
  console.log(`Site olusturuldu: ${APARTMENT_ID}`);
}

async function ensureBlocks() {
  const core = createCoreService();
  const existing = await core.listBlocks(APARTMENT_ID, 'all');
  for (const name of ['A Blok', 'B Blok']) {
    if (existing.some((b) => b.name === name)) continue;
    await core.createBlock(ACTOR, APARTMENT_ID, { name });
    console.log(`Blok olusturuldu: ${name}`);
  }
}

getDynamo();
await ensureTable();
await ensureSite();
await ensureBlocks();
console.log('Yerel veritabani hazir.');
