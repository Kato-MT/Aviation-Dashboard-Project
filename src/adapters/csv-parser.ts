export interface ParsedCsv {
  records: string[][];
  errors: Array<{ rowNumber: number; message: string }>;
}

/** Small RFC 4180 parser used by the engineering core in both browsers and Node. */
export function parseCsv(input: string): ParsedCsv {
  const records: string[][] = [];
  const errors: ParsedCsv['errors'] = [];
  let record: string[] = [];
  let field = '';
  let inQuotes = false;
  let rowNumber = 1;

  const finishField = (): void => {
    record.push(field);
    field = '';
  };

  const finishRecord = (): void => {
    finishField();
    if (record.some((value) => value.trim() !== '')) {
      records.push(record);
      rowNumber += 1;
    }
    record = [];
  };

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (inQuotes) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      if (field.length === 0) inQuotes = true;
      else {
        errors.push({ rowNumber, message: 'Unexpected quote inside an unquoted field.' });
        field += character;
      }
    } else if (character === ',') {
      finishField();
    } else if (character === '\n') {
      finishRecord();
    } else if (character === '\r') {
      if (input[index + 1] === '\n') index += 1;
      finishRecord();
    } else {
      field += character;
    }
  }

  if (inQuotes)
    errors.push({ rowNumber, message: 'Quoted field was not closed before end of input.' });
  if (field.length > 0 || record.length > 0) finishRecord();

  return { records, errors };
}

export function recordsToObjects(records: string[][]): {
  headers: string[];
  rows: Array<Record<string, string | undefined>>;
} {
  const headers = records[0]?.map((header) => header.trim().replace(/^\uFEFF/, '')) ?? [];
  const rows = records
    .slice(1)
    .map((record) => Object.fromEntries(headers.map((header, index) => [header, record[index]])));
  return { headers, rows };
}
