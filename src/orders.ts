import { OrderType, Side } from "@polymarket/clob-client";
import type { SignedOrder } from "@polymarket/order-utils";
import { getClient } from "./client.js";
import { BOT_CONFIG } from "./config.js";
import type { LadderLevel, MarketInfo, OrderInfo } from "./types.js";

/**
 * Post multiple ladder orders in a single batch request (up to 15 orders).
 * More efficient than posting one by one.
 */
export async function postLadderOrders(
  ladder: LadderLevel[],
  tokenId: string,
  market: MarketInfo
): Promise<OrderInfo[]> {
  const client = getClient();
  const orders: OrderInfo[] = [];
  
  // Filter valid levels
  const validLevels = ladder.filter(level => {
    if (level.sizeShares < BOT_CONFIG.minOrderSize) {
      console.log(`[Orders] Skipping ${level.side} @ ${level.price.toFixed(3)}: size ${level.sizeShares} < min ${BOT_CONFIG.minOrderSize}`);
      return false;
    }
    return true;
  });
  
  if (validLevels.length === 0) {
    return orders;
  }
  
  // Build signed orders for batch posting
  const batchArgs: Array<{ order: SignedOrder; orderType: OrderType; postOnly: boolean; level: LadderLevel }> = [];
  
  for (const level of validLevels) {
    const orderSide = level.orderSide === "BUY" ? Side.BUY : Side.SELL;
    
    try {
      const signedOrder = await client.createOrder(
        {
          tokenID: tokenId,
          price: level.price,
          side: orderSide,
          size: level.sizeShares,
        },
        { tickSize: market.tickSize, negRisk: market.negRisk }
      );
      
      batchArgs.push({
        order: signedOrder,
        orderType: OrderType.GTC,
        postOnly: true,
        level,
      });
    } catch (err) {
      console.error(`[Orders] Failed to create ${level.orderSide} order at ${level.price}:`, err);
    }
  }
  
  if (batchArgs.length === 0) {
    return orders;
  }
  
  // Post batch (up to 15 orders per request)
  try {
    const results = await client.postOrders(
      batchArgs.map(({ order, orderType, postOnly }) => ({ order, orderType, postOnly })),
      false, // deferExec
      true   // defaultPostOnly
    );
    
    // Parse results - response is array of order results
    if (Array.isArray(results)) {
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const arg = batchArgs[i];
        
        if (result?.orderID || result?.orderId) {
          const orderId = result.orderID || result.orderId;
          orders.push({
            orderId,
            tokenId,
            side: arg.level.orderSide,
            price: arg.level.price,
            size: arg.level.sizeShares,
            filledSize: 0,
          });
          console.log(`[Orders] Posted ${arg.level.orderSide} ${arg.level.sizeShares} ${arg.level.side} @ ${arg.level.price.toFixed(3)} | Rebate: $${arg.level.expectedRebate.toFixed(4)}`);
        } else if (result?.errorMsg) {
          console.error(`[Orders] Batch order ${i} failed: ${result.errorMsg}`);
        }
      }
    } else if (results?.orderID || results?.orderId) {
      // Single order response
      const orderId = results.orderID || results.orderId;
      const arg = batchArgs[0];
      orders.push({
        orderId,
        tokenId,
        side: arg.level.orderSide,
        price: arg.level.price,
        size: arg.level.sizeShares,
        filledSize: 0,
      });
      console.log(`[Orders] Posted ${arg.level.orderSide} ${arg.level.sizeShares} ${arg.level.side} @ ${arg.level.price.toFixed(3)}`);
    }
    
    console.log(`[Orders] Batch posted ${orders.length}/${batchArgs.length} orders for ${validLevels[0]?.side || "?"}`);
  } catch (err) {
    console.error(`[Orders] Batch post failed:`, err);
    // Fallback: try posting individually
    for (const arg of batchArgs) {
      try {
        const result = await client.postOrder(arg.order, arg.orderType, arg.postOnly);
        if (result?.orderID || result?.orderId) {
          const orderId = result.orderID || result.orderId;
          orders.push({
            orderId,
            tokenId,
            side: arg.level.orderSide,
            price: arg.level.price,
            size: arg.level.sizeShares,
            filledSize: 0,
          });
          console.log(`[Orders] Posted ${arg.level.orderSide} ${arg.level.sizeShares} ${arg.level.side} @ ${arg.level.price.toFixed(3)}`);
        }
      } catch (innerErr) {
        console.error(`[Orders] Individual post failed for ${arg.level.price}:`, innerErr);
      }
    }
  }

  return orders;
}

/**
 * Post both UP and DOWN ladders in a single batch request.
 * More efficient - combines both sides into one API call (up to 15 orders).
 */
export async function postBothLadders(
  upLadder: LadderLevel[],
  downLadder: LadderLevel[],
  upTokenId: string,
  downTokenId: string,
  market: MarketInfo
): Promise<{ upOrders: OrderInfo[]; downOrders: OrderInfo[] }> {
  const client = getClient();
  const upOrders: OrderInfo[] = [];
  const downOrders: OrderInfo[] = [];
  
  // Combine and filter valid levels
  const allLevels: Array<{ level: LadderLevel; tokenId: string; isUp: boolean }> = [];
  
  for (const level of upLadder) {
    if (level.sizeShares >= BOT_CONFIG.minOrderSize) {
      allLevels.push({ level, tokenId: upTokenId, isUp: true });
    }
  }
  for (const level of downLadder) {
    if (level.sizeShares >= BOT_CONFIG.minOrderSize) {
      allLevels.push({ level, tokenId: downTokenId, isUp: false });
    }
  }
  
  if (allLevels.length === 0) {
    return { upOrders, downOrders };
  }
  
  // Limit to 15 orders per batch
  const batchLevels = allLevels.slice(0, 15);
  
  // Build signed orders
  const batchArgs: Array<{ order: SignedOrder; orderType: OrderType; postOnly: boolean; level: LadderLevel; tokenId: string; isUp: boolean }> = [];
  
  for (const { level, tokenId, isUp } of batchLevels) {
    const orderSide = level.orderSide === "BUY" ? Side.BUY : Side.SELL;
    
    try {
      const signedOrder = await client.createOrder(
        {
          tokenID: tokenId,
          price: level.price,
          side: orderSide,
          size: level.sizeShares,
        },
        { tickSize: market.tickSize, negRisk: market.negRisk }
      );
      
      batchArgs.push({
        order: signedOrder,
        orderType: OrderType.GTC,
        postOnly: true,
        level,
        tokenId,
        isUp,
      });
    } catch (err) {
      console.error(`[Orders] Failed to create ${level.side} order at ${level.price}:`, err);
    }
  }
  
  if (batchArgs.length === 0) {
    return { upOrders, downOrders };
  }
  
  // Post batch
  try {
    const results = await client.postOrders(
      batchArgs.map(({ order, orderType, postOnly }) => ({ order, orderType, postOnly })),
      false,
      true
    );
    
    if (Array.isArray(results)) {
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const arg = batchArgs[i];
        
        if (result?.orderID || result?.orderId) {
          const orderId = result.orderID || result.orderId;
          const orderInfo: OrderInfo = {
            orderId,
            tokenId: arg.tokenId,
            side: arg.level.orderSide,
            price: arg.level.price,
            size: arg.level.sizeShares,
            filledSize: 0,
          };
          
          if (arg.isUp) {
            upOrders.push(orderInfo);
          } else {
            downOrders.push(orderInfo);
          }
          console.log(`[Orders] Posted ${arg.level.orderSide} ${arg.level.sizeShares} ${arg.level.side} @ ${arg.level.price.toFixed(2)}`);
        } else if (result?.errorMsg) {
          console.error(`[Orders] Batch order failed: ${result.errorMsg}`);
        }
      }
    }
    
    console.log(`[Orders] Batch: ${upOrders.length} UP + ${downOrders.length} DOWN orders posted`);
  } catch (err) {
    console.error(`[Orders] Batch post failed:`, err);
  }
  
  return { upOrders, downOrders };
}

export async function cancelAllOrders(): Promise<void> {
  const client = getClient();
  try {
    await client.cancelAll();
    console.log("[Orders] Cancelled all orders");
  } catch (err) {
    console.error("[Orders] Failed to cancel all orders:", err);
  }
}

export async function cancelOrder(orderId: string): Promise<void> {
  const client = getClient();
  try {
    await client.cancelOrder({ orderID: orderId });
    console.log(`[Orders] Cancelled order ${orderId}`);
  } catch (err) {
    console.error(`[Orders] Failed to cancel order ${orderId}:`, err);
  }
}

export async function cancelOrdersForMarket(conditionId: string): Promise<void> {
  const client = getClient();
  try {
    await client.cancelMarketOrders({ market: conditionId });
    console.log(`[Orders] Cancelled all orders for market ${conditionId}`);
  } catch (err) {
    console.error(`[Orders] Failed to cancel market orders:`, err);
  }
}

export async function getOpenOrders(): Promise<OrderInfo[]> {
  const client = getClient();
  const response = await client.getOpenOrders();

  return response.map((order) => ({
    orderId: order.id,
    tokenId: order.asset_id,
    side: order.side === "BUY" ? "BUY" : "SELL",
    price: parseFloat(order.price),
    size: parseFloat(order.original_size),
    filledSize: parseFloat(order.original_size) - parseFloat(order.size_matched),
  }));
}

/**
 * Get order by ID to check fill status
 */
export async function getOrder(orderId: string): Promise<OrderInfo | null> {
  const client = getClient();
  try {
    const order = await client.getOrder(orderId);
    if (!order) return null;
    
    return {
      orderId: order.id,
      tokenId: order.asset_id,
      side: order.side === "BUY" ? "BUY" : "SELL",
      price: parseFloat(order.price),
      size: parseFloat(order.original_size),
      filledSize: parseFloat(order.size_matched || "0"),
    };
  } catch {
    return null;
  }
}

/**
 * Aggressive sell - marketable limit order at best bid price.
 * Uses GTC order that should fill immediately if priced at best bid.
 */
export async function aggressiveSell(tokenId: string, size: number, market: MarketInfo): Promise<boolean> {
  const client = getClient();
  
  if (size < BOT_CONFIG.minOrderSize) {
    console.log(`[Orders] Aggressive sell skipped: size ${size} < min ${BOT_CONFIG.minOrderSize}`);
    return false;
  }
  
  try {
    // Get best bid to place marketable limit order
    const book = await client.getOrderBook(tokenId);
    const bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0.01;
    const tickSize = parseFloat(market.tickSize);
    
    // Place at best bid (will fill immediately as taker)
    const sellPrice = Math.max(tickSize, bestBid);
    
    const result = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: sellPrice,
        side: Side.SELL,
        size,
      },
      { tickSize: market.tickSize, negRisk: market.negRisk },
      OrderType.GTC,
      false // not post-only, so can take liquidity
    );
    console.log(`[Orders] Aggressive SELL ${size} @ ${sellPrice.toFixed(2)} -> ${result.orderID || "filled"}`);
    return true;
  } catch (err) {
    console.error("[Orders] Aggressive sell failed:", err);
    return false;
  }
}

/**
 * Aggressive buy - marketable limit order at best ask price.
 */
export async function aggressiveBuy(tokenId: string, size: number, market: MarketInfo): Promise<boolean> {
  const client = getClient();
  
  if (size < BOT_CONFIG.minOrderSize) {
    console.log(`[Orders] Aggressive buy skipped: size ${size} < min ${BOT_CONFIG.minOrderSize}`);
    return false;
  }
  
  try {
    // Get best ask to place marketable limit order
    const book = await client.getOrderBook(tokenId);
    const bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : 0.99;
    
    const result = await client.createAndPostOrder(
      {
        tokenID: tokenId,
        price: bestAsk,
        side: Side.BUY,
        size,
      },
      { tickSize: market.tickSize, negRisk: market.negRisk },
      OrderType.GTC,
      false // not post-only, so can take liquidity
    );
    console.log(`[Orders] Aggressive BUY ${size} @ ${bestAsk.toFixed(2)} -> ${result.orderID || "filled"}`);
    return true;
  } catch (err) {
    console.error("[Orders] Aggressive buy failed:", err);
    return false;
  }
}

/**
 * Batch aggressive sell both UP and DOWN tokens in one operation.
 */
export async function aggressiveSellBoth(
  upTokenId: string,
  upSize: number,
  downTokenId: string,
  downSize: number,
  market: MarketInfo
): Promise<{ upSold: boolean; downSold: boolean }> {
  const client = getClient();
  const result = { upSold: false, downSold: false };
  
  // Build orders for both sides
  const ordersToPost: Array<{ order: SignedOrder; orderType: OrderType; postOnly: boolean; side: "UP" | "DOWN"; size: number }> = [];
  
  // UP side
  if (upSize >= BOT_CONFIG.minOrderSize) {
    try {
      const book = await client.getOrderBook(upTokenId);
      const bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0.01;
      const sellPrice = Math.max(parseFloat(market.tickSize), bestBid);
      
      const signedOrder = await client.createOrder(
        { tokenID: upTokenId, price: sellPrice, side: Side.SELL, size: upSize },
        { tickSize: market.tickSize, negRisk: market.negRisk }
      );
      ordersToPost.push({ order: signedOrder, orderType: OrderType.GTC, postOnly: false, side: "UP", size: upSize });
    } catch (err) {
      console.error("[Orders] Failed to create UP sell:", err);
    }
  }
  
  // DOWN side
  if (downSize >= BOT_CONFIG.minOrderSize) {
    try {
      const book = await client.getOrderBook(downTokenId);
      const bestBid = book.bids.length > 0 ? parseFloat(book.bids[0].price) : 0.01;
      const sellPrice = Math.max(parseFloat(market.tickSize), bestBid);
      
      const signedOrder = await client.createOrder(
        { tokenID: downTokenId, price: sellPrice, side: Side.SELL, size: downSize },
        { tickSize: market.tickSize, negRisk: market.negRisk }
      );
      ordersToPost.push({ order: signedOrder, orderType: OrderType.GTC, postOnly: false, side: "DOWN", size: downSize });
    } catch (err) {
      console.error("[Orders] Failed to create DOWN sell:", err);
    }
  }
  
  if (ordersToPost.length === 0) {
    return result;
  }
  
  // Batch post
  try {
    const results = await client.postOrders(
      ordersToPost.map(({ order, orderType, postOnly }) => ({ order, orderType, postOnly })),
      false,
      false
    );
    
    if (Array.isArray(results)) {
      for (let i = 0; i < results.length; i++) {
        const res = results[i];
        const order = ordersToPost[i];
        if (res?.orderID || res?.orderId) {
          console.log(`[Orders] Aggressive SELL ${order.size} ${order.side} -> ${res.orderID || res.orderId}`);
          if (order.side === "UP") result.upSold = true;
          else result.downSold = true;
        } else if (res?.errorMsg) {
          console.error(`[Orders] ${order.side} sell failed: ${res.errorMsg}`);
        }
      }
    }
  } catch (err) {
    console.error("[Orders] Batch aggressive sell failed:", err);
  }
  
  return result;
}

// Backward compatibility aliases
export const marketSell = aggressiveSell;
export const marketBuy = aggressiveBuy;
