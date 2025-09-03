import { register } from 'node:module';
import { pathToFileURL } from 'node:url';

// Register ts-node's ESM loader using Node's recommended API
register('ts-node/esm', pathToFileURL('./'));

