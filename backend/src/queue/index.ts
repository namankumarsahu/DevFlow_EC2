import { Queue } from 'bullmq';
import { createRedis } from '../redis';

export const QUEUE_NAME = 'deployments';

let queue: Queue | undefined;
export const getQueue = () =>
  (queue ??= new Queue(QUEUE_NAME, {
    connection: createRedis(),
    defaultJobOptions: { removeOnComplete: 1000, removeOnFail: 1000 },
  }));
