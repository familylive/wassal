import { Server } from 'socket.io';

export let io = null;

export function initRealtime(httpServer) {
  io = new Server(httpServer, { cors: { origin: '*' } });
  io.on('connection', (socket) => {
    const auth = socket.handshake.auth || {};
    if (auth.role === 'admin') socket.join('admin');
    if (auth.restaurant_id && ['restaurant','owner','manager','supervisor','quality','cashier'].includes(auth.role)) socket.join(`restaurant:${auth.restaurant_id}`);
    if (auth.role === 'captain' && auth.captain_id) socket.join(`captain:${auth.captain_id}`);
    if (auth.role === 'captain') socket.join('captains');
  });
  return io;
}

export const emitTo = (room, event, data) => { if (io) io.to(room).emit(event, data); };
export const emitAll = (event, data) => { if (io) io.emit(event, data); };
