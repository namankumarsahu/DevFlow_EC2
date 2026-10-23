import IORedis from 'ioredis';
import { config } from './config';

// BullMQ requires maxRetriesPerRequest: null
export const createRedis = () => new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

let shared: IORedis | undefined;
export const getRedis = () => (shared ??= createRedis());
