import express from 'express';
import mongoose from 'mongoose';

const app = express();
app.use(express.json());

let cached = global.mongoose;

if (!cached) {
  cached = global.mongoose = { conn: null, promise: null };
}

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) return null;

  if (cached.conn) return cached.conn;

  if (!cached.promise) {
    cached.promise = mongoose.connect(uri, { bufferCommands: false }).then((mongoose) => mongoose);
  }

  cached.conn = await cached.promise;
  return cached.conn;
}

const messageSchema = new mongoose.Schema({
  text: { type: String, required: true },
  createdAt: { type: Date, default: Date.now },
});

const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);

app.get('/api/health', async (_req, res) => {
  try {
    await connectDB();
    res.json({ status: 'ok', database: process.env.MONGODB_URI ? 'connected' : 'not configured' });
  } catch (error) {
    res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/api/hello', async (_req, res) => {
  try {
    await connectDB();
    if (process.env.MONGODB_URI) {
      const count = await Message.countDocuments();
      res.json({ message: 'Hello World', documents: count });
    } else {
      res.json({ message: 'Hello World' });
    }
  } catch (error) {
    res.status(500).json({ message: 'Hello World', error: error.message });
  }
});

export default app;
