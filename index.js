const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const admin = require('firebase-admin');
const { v4: uuidv4 } = require('uuid');
const dgram = require('dgram');

// Initialize Firebase Admin with environment variables
const getFirebaseConfig = () => {
  try {
    const privateKey = process.env.FIREBASE_PRIVATE_KEY;
    const projectId = process.env.FIREBASE_PROJECT_ID;
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

    if (!privateKey || !projectId || !clientEmail) {
      console.error('Missing Firebase credentials:', {
        hasPrivateKey: !!privateKey,
        hasProjectId: !!projectId,
        hasClientEmail: !!clientEmail
      });
      throw new Error('Missing required Firebase credentials');
    }

    return {
      credential: admin.credential.cert({
        projectId: projectId,
        clientEmail: clientEmail,
        privateKey: privateKey.replace(/\\n/g, '\n')
      }),
      databaseURL: `https://${projectId}.firebaseio.com`
    };
  } catch (error) {
    console.error('Error getting Firebase config:', error);
    throw error;
  }
};

// Initialize Firebase Admin
let db;
try {
  const config = getFirebaseConfig();
  admin.initializeApp(config);
  db = admin.firestore();
  console.log('Firebase Admin initialized successfully');
} catch (error) {
  console.error('Failed to initialize Firebase:', error);
  process.exit(1); // Exit if we can't connect to Firebase
}

const app = express();
const httpServer = createServer(app);

// Configure CORS from environment variables
const corsOrigins = process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',') : [
  'http://localhost:5173',
  'https://uq3l-1233c.web.app',
  'https://uq3l-1233c.firebaseapp.com',
  'https://ema-gaming.onrender.com',
  'https://ema-gaming.web.app'
];

console.log('Allowed CORS origins:', corsOrigins);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    
    if (corsOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));

// Add request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

// Add error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ 
    status: 'error',
    message: 'Something broke!',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

// Root endpoint for health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'ok',
    message: 'Server is running',
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development'
  });
});

// Debug endpoint
app.get('/debug', (req, res) => {
  res.json({
    status: 'ok',
    env: process.env.NODE_ENV,
    port: process.env.PORT,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    firebase: {
      initialized: !!admin.apps.length,
      projectId: process.env.FIREBASE_PROJECT_ID
    },
    endpoints: app._router.stack
      .filter(r => r.route)
      .map(r => ({ 
        path: r.route.path, 
        methods: Object.keys(r.route.methods) 
      }))
  });
});

// Server status endpoint
app.get('/api/server-status/:ip/:port', async (req, res) => {
  const { ip, port } = req.params;
  console.log(`Checking status for ${ip}:${port}`);
  
  try {
    if (!ip || !port) {
      return res.status(400).json({ 
        status: 'error',
        players: 0,
        maxPlayers: 32,
        error: 'Invalid IP or port' 
      });
    }

    const parsedPort = parseInt(port);
    if (isNaN(parsedPort) || parsedPort <= 0 || parsedPort > 65535) {
      return res.status(400).json({ 
        status: 'error',
        players: 0,
        maxPlayers: 32,
        error: 'Invalid port number' 
      });
    }

    const status = await queryGameServer(ip, parsedPort);
    res.json(status);
  } catch (error) {
    console.error('Server status error:', error);
    res.status(500).json({ 
      status: 'offline',
      players: 0,
      maxPlayers: 32,
      error: error.message 
    });
  }
});

// Configure Socket.IO with CORS
const io = new Server(httpServer, {
  cors: {
    origin: corsOrigins,
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});

// Map to store connected users
const connectedUsers = new Map();

// Save message to Firestore
const saveMessage = async (message) => {
  try {
    const messagesRef = db.collection('messages');
    await messagesRef.add({
      ...message,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (error) {
    console.error('Error saving message:', error);
  }
};

// Get chat history from Firestore
const getChatHistory = async (limit = 50) => {
  try {
    const messagesRef = db.collection('messages');
    const snapshot = await messagesRef
      .orderBy('timestamp', 'desc')
      .limit(limit)
      .get();
    
    return snapshot.docs
      .map(doc => ({ id: doc.id, ...doc.data() }))
      .reverse();
  } catch (error) {
    console.error('Error getting chat history:', error);
    return [];
  }
};

// Function to query game server status
const queryGameServer = (ip, port) => {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket('udp4');
    const queryPacket = Buffer.from('ÿÿÿÿgetstatus', 'binary');
    
    client.on('message', (msg) => {
      try {
        const response = msg.toString();
        const [statusLine, ...playerLines] = response.split('\n');
        const [, ...statusVars] = statusLine.split('\\');
        
        const status = {
          status: 'online',
          players: playerLines.length - 1, // -1 because last line is empty
          maxPlayers: 32, // Default max players
          map: 'unknown',
          gametype: 'unknown'
        };

        // Parse status variables
        for (let i = 0; i < statusVars.length; i += 2) {
          const key = statusVars[i];
          const value = statusVars[i + 1];
          if (key === 'sv_maxclients') status.maxPlayers = parseInt(value);
          if (key === 'mapname') status.map = value;
          if (key === 'g_gametype') status.gametype = value;
        }

        client.close();
        resolve(status);
      } catch (error) {
        client.close();
        reject(error);
      }
    });

    client.on('error', (error) => {
      client.close();
      reject(error);
    });

    // Set timeout
    setTimeout(() => {
      client.close();
      reject(new Error('Timeout'));
    }, 3000);

    // Send query
    client.send(queryPacket, 0, queryPacket.length, port, ip);
  });
};

io.on('connection', async (socket) => {
  console.log('New connection:', socket.id);

  // Verify user on connection
  const auth = socket.handshake.auth;
  if (!auth || !auth.uid) {
    console.log('No auth data, disconnecting');
    socket.disconnect();
    return;
  }

  // Add user to connected users
  connectedUsers.set(socket.id, {
    id: auth.uid,
    name: auth.displayName || 'Anonymous',
    email: auth.email,
    avatar: auth.photoURL
  });

  // Send chat history
  const history = await getChatHistory();
  socket.emit('chat:history', history);

  // Handle new messages
  socket.on('chat:message', async (messageData) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;

    const message = {
      id: uuidv4(),
      text: messageData.text,
      sender: user,
      timestamp: Date.now()
    };

    // Save to Firestore
    await saveMessage(message);

    // Broadcast to all clients
    io.emit('chat:message', message);
  });

  // Handle typing status
  socket.on('chat:typing', (isTyping) => {
    const user = connectedUsers.get(socket.id);
    if (!user) return;

    socket.broadcast.emit('chat:typing', {
      user: { name: user.name },
      isTyping
    });
  });

  // Handle disconnection
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    const user = connectedUsers.get(socket.id);
    if (user) {
      socket.broadcast.emit('chat:typing', {
        user: { name: user.name },
        isTyping: false
      });
    }
    connectedUsers.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
