import { log } from '@crawlee/cheerio';

// The builders warn about every input they skip, and the tests feed them plenty on purpose.
log.setLevel(log.LEVELS.OFF);
