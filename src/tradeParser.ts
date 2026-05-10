import fs from 'fs';
import { parse } from 'csv-parse';

export interface RawTrade {
  ticket: string;
  symbol: string;
  type: 'Buy' | 'Sell';
  openPrice: number;
  closePrice: number;
  openTime: Date;
  closeTime: Date;
  size: number;
  rawPnl: number;
  netPoints: number;
}

export class TradeParser {
  static async parseSqxCsv(filePath: string): Promise<RawTrade[]> {
    return new Promise((resolve, reject) => {
      const results: RawTrade[] = [];
      const parser = parse({
        delimiter: ';',
        columns: true,
        trim: true,
        skip_empty_lines: true
      });

      fs.createReadStream(filePath)
        .pipe(parser)
        .on('data', (row: any) => {
          // Parse values
          const ticket = row['Ticket'];
          const symbol = row['Symbol'];
          const type = row['Type'] as 'Buy' | 'Sell';
          const openPrice = parseFloat(row['Open price']);
          const closePrice = parseFloat(row['Close price']);
          const openTimeStr = row['Open time'];
          const closeTimeStr = row['Close time'];
          const size = parseFloat(row['Size']);
          const rawPnl = parseFloat(row['Profit/Loss']);

          if (isNaN(openPrice) || isNaN(closePrice)) return;

          // Convert SQX format "YYYY.MM.DD HH:mm:ss" to ISO string
          const parseDate = (dateStr: string) => {
            const [datePart, timePart] = dateStr.split(' ');
            const formattedDate = datePart.replace(/\./g, '-');
            return new Date(`${formattedDate}T${timePart}Z`);
          };

          // Calculate net points
          // Buy: Close - Open
          // Sell: Open - Close
          const netPoints = type === 'Buy' 
            ? closePrice - openPrice 
            : openPrice - closePrice;

          results.push({
            ticket,
            symbol,
            type,
            openPrice,
            closePrice,
            openTime: parseDate(openTimeStr),
            closeTime: parseDate(closeTimeStr),
            size,
            rawPnl,
            netPoints
          });
        })
        .on('end', () => {
          // Sort by openTime just in case
          results.sort((a, b) => a.openTime.getTime() - b.openTime.getTime());
          resolve(results);
        })
        .on('error', (err) => {
          reject(err);
        });
    });
  }
}
