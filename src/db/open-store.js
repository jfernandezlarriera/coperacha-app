// Builds the Store for the configured backend: the local JSON file by default, mirrored to
// S3 when DATABASE_S3_BUCKET is set (the container disk is ephemeral on App Runner).
import { Store } from './store.js';
import { S3Mirror } from './s3-mirror.js';
import { log } from '../logger.js';

export async function openStore(config, { objects } = {}) {
  if (!config.databaseS3Bucket) return new Store(config.databasePath);
  let remoteObjects = objects;
  if (!remoteObjects) {
    const { createS3Objects } = await import('./s3-objects.js');
    remoteObjects = createS3Objects({ bucket: config.databaseS3Bucket, key: config.databaseS3Key, region: config.awsRegion });
  }
  const store = new Store(config.databasePath, { remote: new S3Mirror({ objects: remoteObjects }) });
  const loaded = await store.loadRemote();
  log.info('store.s3.ready', { bucket: config.databaseS3Bucket, key: config.databaseS3Key, loaded });
  return store;
}
