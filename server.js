const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(express.static('public'));

const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// 房间数据
const rooms = new Map();

// 生成6位房间号
function genRoomId() {
    return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 创建牌组
function createDeck() {
    const deck = [];
    for (let s of SUITS) for (let v of VALUES) deck.push({ suit: s, value: v });
    return deck;
}

// 洗牌
function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

// 移除成对的牌，返回剩余牌和配对牌
function removePairs(hand) {
    const count = {};
    const remaining = [];
    const paired = [];
    for (let card of hand) {
        if (!count[card.value]) count[card.value] = [];
        count[card.value].push(card);
    }
    for (let v in count) {
        const cards = count[v];
        const p = Math.floor(cards.length / 2);
        for (let i = 0; i < p * 2; i++) paired.push(cards[i]);
        for (let i = p * 2; i < cards.length; i++) remaining.push(cards[i]);
    }
    return { remaining, paired };
}

// 初始化游戏
function initGame(room) {
    let deck = shuffle(createDeck());
    
    // 抽底牌
    const secretIdx = Math.floor(Math.random() * deck.length);
    const secretCard = deck.splice(secretIdx, 1)[0];
    
    // 发牌
    const p1Hand = [];
    const p2Hand = [];
    for (let i = 0; i < deck.length; i++) {
        i % 2 === 0 ? p1Hand.push(deck[i]) : p2Hand.push(deck[i]);
    }
    
    // 弃对
    const p1Res = removePairs(p1Hand);
    const p2Res = removePairs(p2Hand);
    const tableCards = [...p1Res.paired, ...p2Res.paired];
    
    // 牌多的先手
    const p1First = p1Res.remaining.length >= p2Res.remaining.length;
    
    room.secretCard = secretCard;
    room.player1.hand = p1Res.remaining;
    room.player2.hand = p2Res.remaining;
    room.tableCards = tableCards;
    room.currentTurn = p1First ? 1 : 2;
    room.gameEnded = false;
    room.cheatMode = 'random'; // random / force_get / force_miss
}

// 广播游戏状态
function broadcastState(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    // 发给房主（完整信息）
    io.to(room.hostId).emit('game-state', {
        myHand: room.player1.hand,
        oppHand: room.player2.hand,
        secretCard: room.secretCard,
        tableCards: room.tableCards,
        currentTurn: room.currentTurn,
        myTurn: room.currentTurn === 1,
        isHost: true,
        gameEnded: room.gameEnded,
        cheatMode: room.cheatMode
    });
    
    // 发给玩家（只看自己的牌）
    if (room.playerId) {
        io.to(room.playerId).emit('game-state', {
            myHand: room.player2.hand,
            oppCount: room.player1.hand.length,
            tableCards: room.tableCards,
            currentTurn: room.currentTurn,
            myTurn: room.currentTurn === 2,
            isHost: false,
            gameEnded: room.gameEnded
        });
    }
}

io.on('connection', (socket) => {
    // 创建房间
    socket.on('create-room', (cb) => {
        let roomId;
        do { roomId = genRoomId(); } while (rooms.has(roomId));
        
        rooms.set(roomId, {
            id: roomId,
            hostId: socket.id,
            playerId: null,
            player1: { hand: [] }, // 房主
            player2: { hand: [] }, // 客人
            secretCard: null,
            tableCards: [],
            currentTurn: 1,
            gameEnded: false,
            cheatMode: 'random'
        });
        
        socket.join(roomId);
        cb({ success: true, roomId });
    });
    
    // 加入房间
    socket.on('join-room', (roomId, cb) => {
        const room = rooms.get(roomId);
        if (!room) return cb({ success: false, msg: '房间不存在' });
        if (room.playerId) return cb({ success: false, msg: '房间已满' });
        
        room.playerId = socket.id;
        socket.join(roomId);
        
        // 初始化游戏
        initGame(room);
        broadcastState(roomId);
        
        cb({ success: true });
        io.to(room.hostId).emit('player-joined');
    });
    
    // 设置作弊模式（仅房主）
    socket.on('set-cheat-mode', (roomId, mode) => {
        const room = rooms.get(roomId);
        if (!room || socket.id !== room.hostId) return;
        room.cheatMode = mode;
        broadcastState(roomId);
    });
    
    // 抽牌
    socket.on('draw-card', (roomId) => {
        const room = rooms.get(roomId);
        if (!room || room.gameEnded) return;
        
        const isHostTurn = socket.id === room.hostId && room.currentTurn === 1;
        const isPlayerTurn = socket.id === room.playerId && room.currentTurn === 2;
        if (!isHostTurn && !isPlayerTurn) return;
        
        const drawerNum = isHostTurn ? 1 : 2;
        const targetNum = drawerNum === 1 ? 2 : 1;
        const targetHand = targetNum === 1 ? room.player1.hand : room.player2.hand;
        const drawerHand = drawerNum === 1 ? room.player1.hand : room.player2.hand;
        
        let drawIdx;
        
        // 作弊逻辑：只有客人抽房主的牌时才生效
        if (drawerNum === 2 && room.cheatMode !== 'random') {
            const turtleIdx = targetHand.findIndex(c => c.value === room.secretCard.value);
            
            if (room.cheatMode === 'force_get' && turtleIdx !== -1) {
                // 必中：强制抽到乌龟牌
                drawIdx = turtleIdx;
            } else if (room.cheatMode === 'force_miss' && turtleIdx !== -1) {
                // 必不中：排除乌龟牌后随机
                const validIdx = [];
                for (let i = 0; i < targetHand.length; i++) {
                    if (i !== turtleIdx) validIdx.push(i);
                }
                if (validIdx.length > 0) {
                    drawIdx = validIdx[Math.floor(Math.random() * validIdx.length)];
                } else {
                    drawIdx = Math.floor(Math.random() * targetHand.length);
                }
            } else {
                drawIdx = Math.floor(Math.random() * targetHand.length);
            }
        } else {
            // 正常随机
            drawIdx = Math.floor(Math.random() * targetHand.length);
        }
        
        const drawnCard = targetHand.splice(drawIdx, 1)[0];
        
        // 检查配对
        const pairIdx = drawerHand.findIndex(c => c.value === drawnCard.value);
        let paired = false;
        
        if (pairIdx !== -1) {
            const pairCard = drawerHand.splice(pairIdx, 1)[0];
            room.tableCards.push(drawnCard, pairCard);
            paired = true;
        } else {
            drawerHand.push(drawnCard);
            room.currentTurn = targetNum; // 换手
        }
        
        // 检查游戏结束
        if (drawerHand.length === 0) {
            room.gameEnded = true;
            room.winner = drawerNum;
        } else if (targetHand.length === 0) {
            room.gameEnded = true;
            room.winner = targetNum;
        }
        
        broadcastState(roomId);
    });
    
    // 重新开始
    socket.on('restart', (roomId) => {
        const room = rooms.get(roomId);
        if (!room || socket.id !== room.hostId) return;
        initGame(room);
        broadcastState(roomId);
    });
    
    // 断开连接
    socket.on('disconnect', () => {
        for (let [id, room] of rooms) {
            if (room.hostId === socket.id) {
                io.to(id).emit('host-left');
                rooms.delete(id);
            } else if (room.playerId === socket.id) {
                room.playerId = null;
                room.gameEnded = true;
                io.to(room.hostId).emit('player-left');
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`游戏服务器运行在端口 ${PORT}`);
});