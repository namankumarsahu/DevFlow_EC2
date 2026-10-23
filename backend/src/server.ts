import http from 'http';
import { createApp } from './app';
import { config } from './config';
import { syncCaddyOnStart } from './lib/caddy';
import { backfillSlugs } from './lib/slug';
import { attachLogServer } from './ws/logs';

const server = http.createServer(createApp());
attachLogServer(server);
server.listen(config.port, () => console.log(`DevFlow API listening on :${config.port}`));

backfillSlugs()
  .catch((e) => console.error('Slug backfill failed:', e))
  .then(() => syncCaddyOnStart());
