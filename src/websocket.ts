import { ClobMarketClient } from "polymarket-websocket-client";
import type { MarketInfo } from "./types.js";

export interface OrderbookLevel {
  price: string;
  size: string;
}

export interface Orderbook {
  bids: OrderbookLevel[];
  asks: OrderbookLevel[];
  timestamp: number;
}

interface BookState {
  [tokenId: string]: Orderbook;
}

type BookUpdateCallback = (tokenId: string, book: Orderbook) => void;

class WebSocketManager {
  private client: ClobMarketClient | null = null;
  private books: BookState = {};
  private subscribedTokens: Set<string> = new Set();
  private onBookUpdate: BookUpdateCallback | null = null;
  private reconnectTimeout: NodeJS.Timeout | null = null;
  private isConnected = false;

  async connect(): Promise<void> {
    if (this.client) {
      return;
    }

    this.client = new ClobMarketClient();

    this.client.on("connected", () => {
      console.log("[WS] Connected to Polymarket");
      this.isConnected = true;
      
      // Re-subscribe to any tokens we were tracking
      if (this.subscribedTokens.size > 0) {
        const tokens = Array.from(this.subscribedTokens);
        console.log(`[WS] Re-subscribing to ${tokens.length} tokens`);
        this.client!.subscribe(tokens);
      }
    });

    this.client.on("disconnected", () => {
      console.log("[WS] Disconnected");
      this.isConnected = false;
      this.scheduleReconnect();
    });

    this.client.on("error", (err: Error) => {
      console.error("[WS] Error:", err.message);
    });

    // Full orderbook snapshot
    this.client.onBook((event: any) => {
      const book: Orderbook = {
        bids: event.bids || [],
        asks: event.asks || [],
        timestamp: Date.now(),
      };
      this.books[event.asset_id] = book;
      
      if (this.onBookUpdate) {
        this.onBookUpdate(event.asset_id, book);
      }
    });

    // Incremental price changes
    this.client.onPriceChange((event: any) => {
      const tokenId = event.asset_id;
      if (!this.books[tokenId]) {
        this.books[tokenId] = { bids: [], asks: [], timestamp: Date.now() };
      }

      const book = this.books[tokenId];

      for (const change of event.price_changes || []) {
        const side = change.side === "BUY" ? "bids" : "asks";
        const orders = book[side];
        const idx = orders.findIndex((o) => o.price === change.price);

        if (Number(change.size) === 0) {
          // Remove order
          if (idx !== -1) orders.splice(idx, 1);
        } else if (idx !== -1) {
          // Update order
          orders[idx] = { price: change.price, size: change.size };
        } else {
          // Add new order
          orders.push({ price: change.price, size: change.size });
        }
      }

      book.timestamp = Date.now();

      if (this.onBookUpdate) {
        this.onBookUpdate(tokenId, book);
      }
    });

    await this.client.connect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeout) return;
    
    this.reconnectTimeout = setTimeout(async () => {
      this.reconnectTimeout = null;
      console.log("[WS] Attempting reconnect...");
      this.client = null;
      await this.connect();
    }, 5000);
  }

  subscribeMarket(market: MarketInfo): void {
    const tokens = [market.upTokenId, market.downTokenId];
    
    for (const token of tokens) {
      if (!this.subscribedTokens.has(token)) {
        this.subscribedTokens.add(token);
      }
    }

    if (this.isConnected && this.client) {
      console.log(`[WS] Subscribing to ${market.question.slice(0, 40)}...`);
      this.client.subscribe(tokens);
    }
  }

  unsubscribeMarket(market: MarketInfo): void {
    this.subscribedTokens.delete(market.upTokenId);
    this.subscribedTokens.delete(market.downTokenId);
    delete this.books[market.upTokenId];
    delete this.books[market.downTokenId];
    
    // Note: polymarket-websocket-client may not have unsubscribe
    // Tokens will just stop updating when market closes
  }

  getBook(tokenId: string): Orderbook | null {
    return this.books[tokenId] || null;
  }

  getBestBid(tokenId: string): number {
    const book = this.books[tokenId];
    if (!book || book.bids.length === 0) return 0;
    
    const sorted = [...book.bids].sort((a, b) => Number(b.price) - Number(a.price));
    return Number(sorted[0].price);
  }

  getBestAsk(tokenId: string): number {
    const book = this.books[tokenId];
    if (!book || book.asks.length === 0) return 1;
    
    const sorted = [...book.asks].sort((a, b) => Number(a.price) - Number(b.price));
    return Number(sorted[0].price);
  }

  getMid(tokenId: string): number {
    const bid = this.getBestBid(tokenId);
    const ask = this.getBestAsk(tokenId);
    return (bid + ask) / 2;
  }

  setOnBookUpdate(callback: BookUpdateCallback): void {
    this.onBookUpdate = callback;
  }

  isReady(): boolean {
    return this.isConnected;
  }

  disconnect(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
    this.isConnected = false;
    this.books = {};
    this.subscribedTokens.clear();
  }
}

// Singleton instance
export const wsManager = new WebSocketManager();
