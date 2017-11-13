const tls = require('tls');
const EventEmitter = require('events');
const decrypt = require('../../utils/decrypt');

const HOST = 'mtalk.google.com';
const PORT = 5228;
const RETRY_MAX_TEMPO = 15; // time before retrying to open the socket (in seconds)
let retryCount = 0;         // retries count of opening socket attempts


const ON_NOTIFICATION_RECEIVED = 'ON_NOTIFICATION_RECEIVED';

const emitter = new EventEmitter();
let timer;

module.exports = {
  ON_NOTIFICATION_RECEIVED,
  connect,
  emitter,
};

async function connect(
  payload,
  RequestType,
  preBuffer,
  NotificationSchema,
  keys,
  persistentIds
) {
  // Retry on disconnect
  const retry = connect.bind(
    this,
    payload,
    RequestType,
    preBuffer,
    NotificationSchema,
    keys,
    persistentIds
  );
  const socket = await connectSocket(retry, RETRY_MAX_TEMPO);
  retryCount = 0;
  timer = process.hrtime();
  console.info('MCS client connected');
  // Payload to send to login with MCS server
  const buffer = toProtoBuf(payload, RequestType);
  socket.write(
    Buffer.concat([preBuffer, buffer], preBuffer.length + buffer.length)
  );
  // Listen for incoming messages
  return listen(socket, NotificationSchema, keys, persistentIds);
}

function connectSocket(retry, retryMaxTempo) {  
  return new Promise(resolve => {
    const socket = new tls.TLSSocket();
    socket.setKeepAlive(true);
    socket.on('close', () => {
      const diff = process.hrtime(timer);
      const minutes = Math.round((diff[0] + diff[1] / 1e9) / 60);
      let retryTempo = Math.min((++retryCount), retryMaxTempo);
      console.warn(`MCS socket closed after ${minutes} minutes`);
      console.warn(`Trying to reconnect after ${retryTempo} sec`);
      setTimeout(function(){ retry(); }, (retryTempo*1000));
    });
    socket.connect(
      {
        host : HOST,
        port : PORT,
      },
      () => resolve(socket)
    );
  });
}

function listen(socket, NotificationSchema, keys, persistentIds) {
  socket.on('data', buffer =>
    onMessageReceived(buffer, NotificationSchema, keys, persistentIds)
  );
  socket.on('error', error => {
    if (error.code === 'ECONNRESET') {
      return console.warn('Connection to MCS server lost');
    }
    console.error('Error while communicating with MCS server');
    console.error(error);
  });
}

function toProtoBuf(payload, Type) {
  const errMsg = Type.verify(payload);
  if (errMsg) throw Error(errMsg);
  const message = Type.create(payload);
  return Type.encode(message).finish();
}

function onMessageReceived(buffer, NotificationSchema, keys, persistentIds) {
  try {
    const object = NotificationSchema.toObject(
      NotificationSchema.decode(buffer),
      {
        longs : String,
        enums : String,
        bytes : Buffer,
      }
    );
    // Already received
    if (persistentIds.includes(object.persistentId)) {
      return;
    }
    const message = decrypt(object, keys);
    if (message) {
      // Send notification
      emitter.emit(ON_NOTIFICATION_RECEIVED, {
        notification : message,
        // Need to be saved by the client
        persistentId : object.persistentId,
      });
    }
  } catch (e) {
    // Not a notification
    return;
  }
}
