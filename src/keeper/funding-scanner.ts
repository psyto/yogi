import { DRIFT_DATA_API } from "../config/constants";
import { STRATEGY_CONFIG } from "../config/vault";

export interface FundingRateData {
  market: string;
  marketIndex: number;
  rate24h: number;
  rate7d: number;
  rate30d: number;
  rate1y: number;
  annualizedPct: number;
  openInterest: number;
}

export async function fetchAllFundingRates(): Promise<FundingRateData[]> {
  const res = await fetch(`${DRIFT_DATA_API}/stats/fundingRates`);
  if (!res.ok) {
    throw new Error(`Failed to fetch funding rates: ${res.status}`);
  }

  const body = (await res.json()) as {
    success: boolean;
    markets: Array<{
      marketIndex: number;
      symbol: string;
      fundingRates: {
        "24h": string;
        "7d": string;
        "30d": string;
        "1y": string;
      };
    }>;
  };

  if (!body.success || !body.markets) {
    throw new Error("Unexpected funding rate API response format");
  }

  return body.markets.map((m) => {
    const rate24h = parseFloat(m.fundingRates["24h"]);
    const rate7d = parseFloat(m.fundingRates["7d"]);
    const rate30d = parseFloat(m.fundingRates["30d"]);
    const rate1y = parseFloat(m.fundingRates["1y"]);
    return {
      market: m.symbol,
      marketIndex: m.marketIndex,
      rate24h,
      rate7d,
      rate30d,
      rate1y,
      annualizedPct: rate24h * 24 * 365 * 100,
      openInterest: 0,
    };
  });
}

export function rankMarketsByFunding(
  rates: FundingRateData[],
  minAnnualizedBps: number
): FundingRateData[] {
  const minPct = minAnnualizedBps / 100;

  // Apply allowed/excluded market filters
  const { allowedMarkets, excludeMarkets } = STRATEGY_CONFIG;

  return rates
    .filter((r) => {
      // Market whitelist/blacklist
      if (excludeMarkets.length > 0 && excludeMarkets.includes(r.market)) {
        return false;
      }
      if (allowedMarkets.length > 0 && !allowedMarkets.includes(r.market)) {
        return false;
      }

      // Only consider markets with positive funding across multiple timeframes
      const positiveTimeframes = [r.rate24h, r.rate7d, r.rate30d].filter(
        (rate) => rate > 0
      ).length;
      return positiveTimeframes >= 2 && r.annualizedPct >= minPct;
    })
    .sort((a, b) => {
      // Score by weighted average of timeframes (favor consistency)
      const scoreA =
        a.rate24h * 0.4 + a.rate7d * 0.35 + a.rate30d * 0.25;
      const scoreB =
        b.rate24h * 0.4 + b.rate7d * 0.35 + b.rate30d * 0.25;
      return scoreB - scoreA;
    });
}

export async function fetchMarketFundingHistory(
  market: string,
  limit = 168
): Promise<{ ts: number; fundingRate: number }[]> {
  const res = await fetch(
    `${DRIFT_DATA_API}/market/${market}/fundingRates?limit=${limit}`
  );
  if (!res.ok) {
    throw new Error(`Failed to fetch funding history for ${market}: ${res.status}`);
  }
  return res.json() as Promise<{ ts: number; fundingRate: number }[]>;
}
