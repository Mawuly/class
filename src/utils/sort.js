'use strict';

/**
 * SQL ORDER BY terms that sort room codes naturally: NLT-2 before NLT-10, G9 before G10.
 * The letters part first, then the number as a number, then the code itself as a tie-break.
 */
function naturalCode(col) {
  return `regexp_replace(${col}, '[0-9]+', '', 'g'), `
    + `NULLIF(regexp_replace(${col}, '[^0-9]', '', 'g'), '')::bigint NULLS FIRST, ${col}`;
}

module.exports = { naturalCode };
