const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Health check
app.get('/health', (req, res) => {
    res.json({ status: 'ok', message: 'Enhanced Time Sync Bot' });
});

// IP DETECTION ENDPOINT
app.get('/api/my-ip', async (req, res) => {
    try {
        const response = await axios.get('https://api.ipify.org');
        const ip = response.data;
        res.json({ 
            success: true, 
            ip: ip,
            message: 'Your Render server IP address'
        });
    } catch (error) {
        res.json({ success: false, error: error.message });
    }
});

// Database (in-memory for active sessions)
const database = {
    sessions: {},
    activeTrades: {}
};

// Win streak tracker
const winStreaks = {};

// Rate limit tracker
const rateLimit = {
    lastRequestTime: 0,
    lastOrderTime: 0,
    requestCount: 0,
    bannedUntil: 0,
    warningCount: 0,
    minuteRequests: [],
    totalWeightUsed: 0,
    timeOffset: 0,  // Store time offset between local and Binance
    lastTimeSync: 0
};

// AI Trading Engine
class AITradingEngine {
    constructor() {
        this.performance = { totalTrades: 0, successfulTrades: 0, totalProfit: 0 };
    }

    analyzeMarket(symbol, marketData, sessionId) {
        const { price = 0, volume24h = 0, priceChange24h = 0, high24h = 0, low24h = 0 } = marketData;
        
        const volumeRatio = volume24h / 1000000;
        const pricePosition = high24h > low24h ? (price - low24h) / (high24h - low24h) : 0.5;
        
        let confidence = 0.7;
        
        if (volumeRatio > 1.3) confidence += 0.15;
        if (volumeRatio > 1.8) confidence += 0.2;
        if (priceChange24h > 3) confidence += 0.2;
        if (priceChange24h > 7) confidence += 0.25;
        if (pricePosition < 0.35) confidence += 0.15;
        if (pricePosition > 0.65) confidence += 0.15;
        
        const currentStreak = winStreaks[sessionId] || 0;
        if (currentStreak > 0) {
            confidence += (currentStreak * 0.05);
        }
        
        confidence = Math.min(confidence, 0.98);
        
        const action = (pricePosition < 0.35 && priceChange24h > -3 && volumeRatio > 1.1) ? 'BUY' :
                      (pricePosition > 0.65 && priceChange24h > 3 && volumeRatio > 1.1) ? 'SELL' : 
                      (Math.random() > 0.2 ? 'BUY' : 'SELL');
        
        return { symbol, price, confidence, action };
    }

    calculatePositionSize(initialInvestment, currentProfit, targetProfit, timeElapsed, timeLimit, confidence, sessionId) {
        const timeRemaining = Math.max(0.1, (timeLimit - timeElapsed) / timeLimit);
        const remainingProfit = Math.max(1, targetProfit - currentProfit);
        
        let baseSize = Math.max(10, initialInvestment * 0.25);
        const timePressure = 1.5 / timeRemaining;
        const targetPressure = remainingProfit / (initialInvestment * 3);
        
        const currentStreak = winStreaks[sessionId] || 0;
        const winBonus = 1 + (currentStreak * 0.3);
        
        let positionSize = baseSize * timePressure * targetPressure * confidence * winBonus;
        const maxPosition = initialInvestment * 4;
        positionSize = Math.min(positionSize, maxPosition);
        positionSize = Math.max(positionSize, 10);
        
        return positionSize;
    }
}

// ENHANCED TIME SYNC - COMPLETE FIX FOR -1130 ERROR
class BinanceAPI {
    static endpoints = {
        base: [
            'https://api.binance.com',
            'https://api1.binance.com',
            'https://api2.binance.com',
            'https://api3.binance.com',
            'https://api4.binance.com'
        ],
        data: ['https://data.binance.com'],
        testnet: ['https://testnet.binance.vision']
    };
    
    static async signRequest(queryString, secret) {
        return crypto
            .createHmac('sha256', secret)
            .update(queryString)
            .digest('hex');
    }

    static async delay(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ENHANCED TIME SYNC - Syncs with Binance and calculates offset
    static async syncTime() {
        const endpoints = [
            'https://api.binance.com/api/v3/time',
            'https://api1.binance.com/api/v3/time',
            'https://api2.binance.com/api/v3/time',
            'https://api3.binance.com/api/v3/time',
            'https://api4.binance.com/api/v3/time',
            'https://data.binance.com/api/v3/time'
        ];
        
        let successfulSyncs = 0;
        let totalOffset = 0;
        
        for (const endpoint of endpoints) {
            try {
                const startTime = Date.now();
                const response = await axios.get(endpoint, { timeout: 5000 });
                const endTime = Date.now();
                const serverTime = response.data.serverTime;
                const localTime = (startTime + endTime) / 2; // Average to account for network latency
                const offset = serverTime - localTime;
                
                console.log(`📡 Time sync via ${endpoint.split('/')[2]}: local=${Math.floor(localTime)}, server=${serverTime}, offset=${Math.floor(offset)}ms`);
                
                totalOffset += offset;
                successfulSyncs++;
                
                // Small delay between sync attempts
                await this.delay(100);
            } catch (error) {
                console.log(`⚠️ Time endpoint failed: ${endpoint}`);
                continue;
            }
        }
        
        if (successfulSyncs > 0) {
            const avgOffset = Math.floor(totalOffset / successfulSyncs);
            rateLimit.timeOffset = avgOffset;
            rateLimit.lastTimeSync = Date.now();
            console.log(`✅ Time synced! Average offset: ${avgOffset}ms`);
            return avgOffset;
        }
        
        console.log('⚠️ All time endpoints failed, using previous offset or zero');
        return rateLimit.timeOffset || 0;
    }

    // Get current timestamp with offset correction
    static async getTimestamp() {
        // Sync time every 5 minutes to stay accurate
        const timeSinceLastSync = Date.now() - rateLimit.lastTimeSync;
        if (timeSinceLastSync > 300000 || rateLimit.timeOffset === 0) {
            await this.syncTime();
        }
        
        const now = Date.now();
        const correctedTimestamp = now + rateLimit.timeOffset;
        
        console.log(`⏰ Timestamp: local=${now}, corrected=${correctedTimestamp}, offset=${rateLimit.timeOffset}ms`);
        
        return correctedTimestamp;
    }

    static async rateLimitDelay() {
        const now = Date.now();
        const timeSinceLastRequest = now - rateLimit.lastRequestTime;
        const minDelay = 1500; // 1.5 seconds
        
        if (timeSinceLastRequest < minDelay) {
            const waitTime = minDelay - timeSinceLastRequest;
            console.log(`⏱️ Rate limit delay: waiting ${waitTime}ms`);
            await this.delay(waitTime);
        }
        rateLimit.lastRequestTime = Date.now();
    }

    static async orderRateLimit() {
        const now = Date.now();
        const timeSinceLastOrder = now - (rateLimit.lastOrderTime || 0);
        const minOrderDelay = 200;
        
        if (timeSinceLastOrder < minOrderDelay) {
            const waitTime = minOrderDelay - timeSinceLastOrder;
            console.log(`⏱️ Order rate limit: waiting ${waitTime}ms`);
            await this.delay(waitTime);
        }
        rateLimit.lastOrderTime = now;
    }

    static validateApiKey(apiKey) {
        if (!apiKey || apiKey.length < 10) {
            return { valid: false, reason: 'API key too short' };
        }
        if (apiKey.includes(' ') || apiKey.includes('\n') || apiKey.includes('\r')) {
            return { valid: false, reason: 'API key contains spaces or line breaks' };
        }
        return { valid: true };
    }

    static async makeRequest(endpoint, method, apiKey, secret, params = {}, useTestnet = false) {
        try {
            // Rate limit protection
            await this.rateLimitDelay();
            
            const keyValidation = this.validateApiKey(apiKey);
            if (!keyValidation.valid) {
                throw new Error(`Invalid API key format: ${keyValidation.reason}`);
            }

            if (rateLimit.bannedUntil > Date.now()) {
                const minutesLeft = Math.ceil((rateLimit.bannedUntil - Date.now()) / 60000);
                throw new Error(`⚠️ IP BANNED for ${minutesLeft} more minutes.`);
            }

            // CRITICAL FIX: Use synced timestamp
            const timestamp = await this.getTimestamp();
            
            // Add recvWindow to handle any remaining time drift
            const queryParams = { 
                ...params, 
                timestamp: timestamp,
                recvWindow: 10000  // 10 seconds buffer
            };
            
            const queryString = Object.keys(queryParams)
                .map(key => `${key}=${queryParams[key]}`)
                .join('&');
            
            const signature = await this.signRequest(queryString, secret);
            
            let endpointsToTry = useTestnet ? this.endpoints.testnet : this.endpoints.base;
            let lastError = null;
            
            for (const baseUrl of endpointsToTry) {
                try {
                    const url = `${baseUrl}${endpoint}?${queryString}&signature=${signature}`;
                    console.log(`📡 Trying: ${baseUrl}`);
                    
                    const response = await axios({
                        method,
                        url,
                        headers: { 'X-MBX-APIKEY': apiKey.trim() },
                        timeout: 10000
                    });
                    
                    // Track rate limit usage
                    const usedWeight = response.headers['x-mbx-used-weight-1m'];
                    if (usedWeight) {
                        const weight = parseInt(usedWeight);
                        console.log(`📊 Rate limit weight: ${weight}/1200`);
                        
                        if (weight > 1000) {
                            rateLimit.warningCount++;
                            console.log(`⚠️ WARNING: ${weight}/1200 (Warning #${rateLimit.warningCount})`);
                            if (rateLimit.warningCount >= 2) {
                                console.log('🛑 High rate limit! Forcing 60 second pause...');
                                await this.delay(60000);
                                rateLimit.warningCount = 0;
                            }
                        } else {
                            rateLimit.warningCount = 0;
                        }
                    }
                    
                    return response.data;
                    
                } catch (err) {
                    lastError = err;
                    const status = err.response?.status;
                    const errorMsg = err.response?.data?.msg || err.message;
                    console.log(`⚠️ ${baseUrl} failed: ${status} - ${errorMsg}`);
                    
                    if (status === 429) {
                        console.log('⛔ RATE LIMIT HIT! Waiting 60 seconds...');
                        await this.delay(60000);
                        continue;
                    }
                    
                    if (status === 418) {
                        const banTimeMatch = errorMsg.match(/\d+/);
                        if (banTimeMatch) {
                            rateLimit.bannedUntil = parseInt(banTimeMatch[0]);
                        }
                        throw err;
                    }
                    
                    await this.delay(1000);
                }
            }
            
            throw lastError || new Error('All endpoints failed');
            
        } catch (error) {
            if (error.response) {
                const status = error.response.status;
                const data = error.response.data;
                console.error('🔴 Binance API Error:', { status, code: data.code, message: data.msg });
                
                // Handle timestamp error specifically
                if (data.code === -1021 || data.code === -1130) {
                    console.log('⏰ Timestamp error detected! Forcing time sync...');
                    await this.syncTime();
                    throw new Error('Timestamp synced, please retry');
                }
                
                if (status === 429) {
                    throw new Error('Rate limit exceeded');
                }
                if (status === 418) {
                    throw new Error(`IP BANNED: ${data.msg}`);
                }
                if (data.code === -2014 || data.code === -2015) {
                    throw new Error('Invalid API key. Enable Spot & Margin Trading.');
                }
            }
            throw error;
        }
    }

    static async getAccountBalance(apiKey, secret, useTestnet = false) {
        try {
            const data = await this.makeRequest('/api/v3/account', 'GET', apiKey, secret, {}, useTestnet);
            const usdtBalance = data.balances.find(b => b.asset === 'USDT');
            return {
                success: true,
                free: parseFloat(usdtBalance?.free || 0),
                locked: parseFloat(usdtBalance?.locked || 0),
                total: parseFloat(usdtBalance?.free || 0) + parseFloat(usdtBalance?.locked || 0)
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    static async getTicker(symbol, useTestnet = false) {
        try {
            const data = await this.makeRequest('/api/v3/ticker/24hr', 'GET', 'dummy', 'dummy', { symbol }, useTestnet);
            return { success: true, data: data };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    static async placeMarketOrder(apiKey, secret, symbol, side, quoteOrderQty, useTestnet = false) {
        try {
            await this.orderRateLimit();
            
            const orderData = await this.makeRequest('/api/v3/order', 'POST', apiKey, secret, {
                symbol,
                side,
                type: 'MARKET',
                quoteOrderQty: quoteOrderQty.toFixed(2)
            }, useTestnet);
            
            let avgPrice = 0;
            if (orderData.fills && orderData.fills.length > 0) {
                let totalValue = 0, totalQty = 0;
                orderData.fills.forEach(fill => {
                    totalValue += parseFloat(fill.price) * parseFloat(fill.qty);
                    totalQty += parseFloat(fill.qty);
                });
                avgPrice = totalValue / totalQty;
            }
            
            return {
                success: true,
                orderId: orderData.orderId,
                executedQty: parseFloat(orderData.executedQty),
                price: avgPrice || parseFloat(orderData.fills?.[0]?.price || 0)
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    static async verifyApiKey(apiKey, secret, useTestnet = false) {
        try {
            const keyValidation = this.validateApiKey(apiKey);
            if (!keyValidation.valid) {
                return { success: false, error: `Invalid format: ${keyValidation.reason}` };
            }
            const data = await this.makeRequest('/api/v3/account', 'GET', apiKey, secret, {}, useTestnet);
            return {
                success: true,
                permissions: data.permissions,
                canTrade: data.canTrade
            };
        } catch (error) {
            return { success: false, error: error.message };
        }
    }
}

const aiEngine = new AITradingEngine();

// API Routes
app.post('/api/connect', async (req, res) => {
    const { email, accountNumber, apiKey, secretKey, accountType } = req.body;
    const useTestnet = accountType === 'testnet';
    
    if (!apiKey || !secretKey) {
        return res.status(400).json({ success: false, message: 'API key and secret are required' });
    }
    
    const cleanApiKey = apiKey.trim().replace(/[\n\r]/g, '');
    const cleanSecretKey = secretKey.trim().replace(/[\n\r]/g, '');
    
    try {
        // First, sync time with Binance
        console.log('🔄 Syncing time with Binance...');
        await BinanceAPI.syncTime();
        
        const verification = await BinanceAPI.verifyApiKey(cleanApiKey, cleanSecretKey, useTestnet);
        
        if (!verification.success) {
            return res.status(401).json({ success: false, message: `API verification failed: ${verification.error}` });
        }
        
        if (!verification.canTrade && !useTestnet) {
            return res.status(403).json({ success: false, message: 'API key does not have trading permission. Enable "Spot & Margin Trading".' });
        }
        
        const balance = await BinanceAPI.getAccountBalance(cleanApiKey, cleanSecretKey, useTestnet);
        const sessionId = 'session_' + Date.now() + '_' + crypto.randomBytes(4).toString('hex');
        
        database.sessions[sessionId] = {
            id: sessionId, email, accountNumber,
            apiKey: cleanApiKey, secretKey: cleanSecretKey,
            connectedAt: new Date(), isActive: true,
            balance: balance.success ? balance.total : (useTestnet ? 10000 : 0),
            useTestnet
        };
        
        winStreaks[sessionId] = 0;
        
        const message = useTestnet 
            ? '✅ Connected to Binance Testnet!'
            : `✅ Connected to REAL Binance! Balance: $${balance.success ? balance.total.toFixed(2) : '0'} USDT`;
        
        res.json({ success: true, sessionId, balance: balance.success ? balance.total : (useTestnet ? 10000 : 0), message });
        
    } catch (error) {
        console.error('Connection error:', error);
        res.status(500).json({ success: false, message: 'Connection failed: ' + error.message });
    }
});

app.post('/api/startTrading', async (req, res) => {
    const { sessionId, initialInvestment, targetProfit, timeLimit, riskLevel, tradingPairs } = req.body;
    
    const session = database.sessions[sessionId];
    if (!session) return res.status(401).json({ success: false, message: 'Invalid session' });
    
    if (!session.useTestnet) {
        const balanceCheck = await BinanceAPI.getAccountBalance(session.apiKey, session.secretKey, false);
        if (!balanceCheck.success || balanceCheck.free < initialInvestment) {
            return res.status(400).json({ success: false, message: `Insufficient balance. Need $${initialInvestment}` });
        }
    }
    
    const botId = 'bot_' + Date.now();
    database.activeTrades[botId] = {
        id: botId, sessionId,
        initialInvestment: parseFloat(initialInvestment) || 10,
        targetProfit: parseFloat(targetProfit) || 100,
        timeLimit: parseFloat(timeLimit) || 1,
        riskLevel: riskLevel || 'aggressive',
        tradingPairs: tradingPairs || ['BTCUSDT', 'ETHUSDT'],
        startedAt: new Date(),
        isRunning: true,
        currentProfit: 0,
        trades: [],
        lastTradeTime: Date.now()
    };
    
    session.activeBot = botId;
    winStreaks[sessionId] = 0;
    
    res.json({ success: true, botId, message: `🔥 TRADING ACTIVE! Target: $${parseFloat(targetProfit).toLocaleString()}` });
});

app.post('/api/stopTrading', (req, res) => {
    const { sessionId } = req.body;
    const session = database.sessions[sessionId];
    if (session?.activeBot) session.activeBot = null;
    res.json({ success: true, message: 'Trading stopped' });
});

// SAFE POLLING: 90 seconds minimum
app.post('/api/tradingUpdate', async (req, res) => {
    const { sessionId } = req.body;
    
    const session = database.sessions[sessionId];
    if (!session?.activeBot) return res.json({ success: true, currentProfit: 0, newTrades: [] });
    
    const trade = database.activeTrades[session.activeBot];
    if (!trade || !trade.isRunning) return res.json({ success: true, currentProfit: trade?.currentProfit || 0, newTrades: [] });
    
    const newTrades = [];
    const now = Date.now();
    
    const timeElapsed = (now - trade.startedAt) / (1000 * 60 * 60);
    const timeRemaining = Math.max(0, trade.timeLimit - timeElapsed);
    const timeSinceLastTrade = (now - (trade.lastTradeTime || 0)) / 1000;
    
    // 90 seconds between trades (SAFE)
    if (timeRemaining > 0 && timeSinceLastTrade >= 90) {
        const symbol = trade.tradingPairs[Math.floor(Math.random() * trade.tradingPairs.length)] || 'BTCUSDT';
        const tickerData = await BinanceAPI.getTicker(symbol, session.useTestnet);
        
        if (tickerData.success) {
            const marketPrice = parseFloat(tickerData.data.lastPrice);
            const marketData = {
                price: marketPrice,
                volume24h: parseFloat(tickerData.data.volume),
                priceChange24h: parseFloat(tickerData.data.priceChangePercent),
                high24h: parseFloat(tickerData.data.highPrice),
                low24h: parseFloat(tickerData.data.lowPrice)
            };
            
            const signal = aiEngine.analyzeMarket(symbol, marketData, sessionId);
            
            if (signal.action !== 'HOLD') {
                const positionSize = aiEngine.calculatePositionSize(
                    trade.initialInvestment, trade.currentProfit, trade.targetProfit,
                    timeElapsed, trade.timeLimit, signal.confidence, sessionId
                );
                
                const orderResult = await BinanceAPI.placeMarketOrder(
                    session.apiKey, session.secretKey, symbol, signal.action, positionSize, session.useTestnet
                );
                
                if (orderResult.success) {
                    const currentTicker = await BinanceAPI.getTicker(symbol, session.useTestnet);
                    const currentPrice = currentTicker.success ? parseFloat(currentTicker.data.lastPrice) : marketPrice;
                    const entryPrice = orderResult.price || marketPrice;
                    
                    let profit = signal.action === 'BUY' 
                        ? (currentPrice - entryPrice) * orderResult.executedQty
                        : (entryPrice - currentPrice) * orderResult.executedQty;
                    
                    if (profit > 0) winStreaks[sessionId] = (winStreaks[sessionId] || 0) + 1;
                    else winStreaks[sessionId] = 0;
                    
                    trade.currentProfit += profit;
                    trade.lastTradeTime = now;
                    
                    newTrades.push({
                        symbol, side: signal.action,
                        quantity: orderResult.executedQty.toFixed(6),
                        price: entryPrice.toFixed(2),
                        profit: profit,
                        size: '$' + positionSize.toFixed(2),
                        confidence: (signal.confidence * 100).toFixed(0) + '%',
                        winStreak: winStreaks[sessionId],
                        timestamp: new Date().toISOString()
                    });
                    
                    trade.trades.unshift(...newTrades);
                    if (trade.currentProfit >= trade.targetProfit) trade.isRunning = false;
                }
            }
        }
    }
    
    if (timeElapsed >= trade.timeLimit) trade.isRunning = false;
    if (trade.trades.length > 50) trade.trades = trade.trades.slice(0, 50);
    
    let balance = { free: session.useTestnet ? 10000 : 0 };
    if (!session.useTestnet) {
        const balanceData = await BinanceAPI.getAccountBalance(session.apiKey, session.secretKey, false);
        if (balanceData.success) balance = balanceData;
    }
    
    res.json({ 
        success: true, 
        currentProfit: trade.currentProfit || 0,
        timeRemaining: timeRemaining.toFixed(2),
        targetReached: trade.targetReached || false,
        timeExceeded: trade.timeExceeded || false,
        newTrades,
        balance: balance.free,
        winStreak: winStreaks[sessionId] || 0
    });
});

app.post('/api/balance', async (req, res) => {
    const { sessionId } = req.body;
    const session = database.sessions[sessionId];
    if (!session) return res.status(401).json({ success: false, message: 'Invalid session' });
    const balance = await BinanceAPI.getAccountBalance(session.apiKey, session.secretKey, session.useTestnet);
    res.json({ success: balance.success, balance: balance.success ? balance.free : 0 });
});

// Serve index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
    console.log('\n' + '='.repeat(60));
    console.log('🌙 HALAL AI TRADING BOT - ENHANCED TIME SYNC VERSION');
    console.log('='.repeat(60));
    console.log(`✅ Server running on port: ${PORT}`);
    console.log(`✅ Time sync: Active (auto-calculates offset)`);
    console.log(`✅ 1.5s delay between ALL API calls`);
    console.log(`✅ 200ms delay between orders`);
    console.log(`✅ 90-second polling interval`);
    console.log(`✅ recvWindow: 10000ms (10s buffer)`);
    console.log('='.repeat(60) + '\n');
});
