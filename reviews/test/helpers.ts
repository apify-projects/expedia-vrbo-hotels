import { readFileSync } from 'node:fs';

const FIXTURES_URL = new URL('fixtures/', import.meta.url);

export const readFixture = (name: string): string => readFileSync(new URL(name, FIXTURES_URL), 'utf8');

// Fixtures are payloads captured off the wire, so they are read as the response types they came from.
export const readJsonFixture = <T>(name: string): T => JSON.parse(readFixture(name)) as T;
