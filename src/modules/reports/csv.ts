/**
 * The CSV writer — one format, streamed, for every report (plan D7).
 *
 * WHY STREAMING IS THE POINT
 * A report is the whole ledger wearing a different column order, and the whole
 * ledger gets big. Buffering `rows` into one string to set a Content-Length
 * would hold every row of every report in memory at once — the exact shape of
 * an out-of-memory at the worst moment. So rows are written through as they are
 * produced, the response has no Content-Length, and Node decides when to flush.
 * "Streams without buffering the whole result" is then true by construction
 * rather than by benchmark.
 *
 * THE FORMAT, STATED ONCE
 * RFC 4180: fields containing a quote, comma, CR or LF are wrapped in double
 * quotes, and a quote inside a quoted field is doubled. Line endings are CRLF.
 * Every report's output goes through this one function, so every report's CSV
 * agrees on the answers — and a description that contains a comma cannot break
 * somebody's spreadsheet.
 */

const QUOTE_PATTERN = /["\r\n,]/;

/** One CSV field. Returns it as-is when safe, quoted when not. */
function field(value: string): string {
  return QUOTE_PATTERN.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * A CSV document that writes itself out as it is fed.
 *
 * The caller awaits `row()` per row — the await is the back-pressure: it makes
 * the writer wait for the stream to drain before producing the next row, which
 * is what keeps a fast query from outrunning a slow client and building an
 * unbounded queue in memory.
 */
export class CsvWriter {
  private readonly response: import("express").Response;
  private headerWritten = false;

  constructor(response: import("express").Response, filename: string) {
    this.response = response;
    response.status(200);
    response.setHeader("content-type", "text/csv; charset=utf-8");
    response.setHeader(
      "content-disposition",
      `attachment; filename="${filename.replace(/"/g, "")}"`,
    );
    response.setHeader("cache-control", "no-store");
    // With no Content-Length the response is chunked, which is the point: the
    // size is not knowable until the last row has been produced.
  }

  /** The header row, from the definition's columns — the same source the HTML
   *  table on screen reads, so a column cannot exist in one and not the other. */
  async header(columns: readonly { key: string; label: string }[]): Promise<void> {
    if (this.headerWritten) return;
    this.headerWritten = true;
    await this.line(columns.map((column) => field(column.label)));
  }

  /** One data row, in the definition's column order. */
  async row(columns: readonly { key: string }[], row: Record<string, unknown>): Promise<void> {
    const cells = columns.map((column) => {
      const value = row[column.key];
      return field(value === null || value === undefined ? "" : String(value));
    });
    await this.line(cells);
  }

  private async line(cells: string[]): Promise<void> {
    const chunk = `${cells.join(",")}\r\n`;
    const response = this.response;

    // false means the client's buffer is full: wait for drain rather than
    // piling rows into memory. true means it went straight through.
    if (response.write(chunk)) return;

    await new Promise<void>((resolve, reject) => {
      response.once("drain", resolve);
      response.once("error", reject);
    });
  }
}
