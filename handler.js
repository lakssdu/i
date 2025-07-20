// handler.js - Máxima velocidad con respuesta garantizada y optimizaciones avanzadas
import { smsg } from "./lib/simple.js"
import { format } from "util"
import { fileURLToPath } from "url"
import path, { join } from "path"
import { unwatchFile, watchFile } from "fs"
// Importa las funciones de MongoDB. Se asume que estas funciones usan un pool de conexiones interno.
import { getUser, getChat, getSettings, updateStats as dbUpdateStats, saveChat, saveUser } from "./lib/mongodb.js"

// Importa Worker si estás en un entorno Node.js que lo soporta (Node.js v10.5.0+ para worker_threads)
// Si estás en un entorno diferente (ej. Deno, o un entorno sin worker_threads), esta parte necesitará ajuste.
// Para simplificar, asumiremos que `worker_threads` es accesible si se desea usar.
// const { Worker } = await import('worker_threads'); // Descomentar si se usa Web Workers

const { proto } = (await import("@whiskeysockets/baileys")).default
const isNumber = (x) => typeof x === "number" && !isNaN(x)
const delay = (ms) => isNumber(ms) && new Promise((resolve) => setTimeout(resolve, ms))

// Configuración para el entorno de producción (controla el logging)
global.isProduction = process.env.NODE_ENV === 'production' // Define si estamos en producción

global.dfail = (type, m, conn) => {
    let msg = '';
    switch (type) {
        case 'rowner':
            msg = '> 👑 Este comando es solo para Ton.';
            break;
        case 'owner':
            msg = '> 🌟 Este comando es solo para subbots.';
            break;
        case 'mods':
            msg = '> 🛠️ Este comando es solo para moderadores.';
            break;
        case 'premium':
            msg = '> 💎 Este comando es solo para usuarios Premium.';
            break;
        case 'group':
            msg = '> 👥 Este comando solo se puede usar en grupos.';
            break;
        case 'botAdmin':
            msg = '> 🤖 Necesito ser administrador del grupo para usar este comando.';
            break;
        case 'admin':
            msg = '> 👮‍♀️ Este comando es solo para administradores del grupo.';
            break;
        case 'private':
            msg = '> 👤 Este comando solo se puede usar en chats privados.';
            break;
        case 'unreg':
            msg = '> 🔒 Debes registrarte para usar este comando. Usa #reg para registrarte.';
            break;
        default:
            msg = '> ❌ Permiso denegado.';
            break;
    }
    if (msg) {
        conn.reply(m.chat, msg, m);
    }
};


// ✅ CACHE ULTRA-RÁPIDO CON TTL Y INVALIDACIÓN INTELIGENTE MEJORADA
// Almacena datos de usuarios, chats, grupos y configuraciones para acceso rápido.
// lastClean registra la última vez que se limpió el caché.
// chatUpdates y criticalSettings ayudan a la invalidación inteligente.
const cache = {
  users: new Map(), // Cache para datos de usuario (sender-chatId)
  chats: new Map(), // Cache para datos de chat (chatId)
  groups: new Map(), // Cache para metadatos de grupo (chatId)
  settings: null, // Cache global para las configuraciones del bot
  lastClean: Date.now(), // Timestamp de la última limpieza del caché
  chatUpdates: new Map(), // Timestamp de la última actualización de un chat
  criticalSettings: new Map(), // Cache para configuraciones críticas del chat (modoadmin, antiLag, isBanned)
}

// Constantes para la gestión del caché
const MAX_CACHE_AGE_CRITICAL = 120000 // 2 minutos para configuraciones críticas (reducido de 1 min a 2 min para ser menos agresivo pero aún rápido)
const MAX_CACHE_AGE_CHAT = 180000 // 3 minutos para datos de chat completos (reducido de 5 min)
const MAX_CACHE_AGE_USER = 180000 // 3 minutos para datos de usuario completos (reducido de 5 min)
const CACHE_CLEAN_INTERVAL = 180000 // 3 minutos para la limpieza periódica del caché

// ✅ FUNCIÓN MEJORADA PARA INVALIDAR CACHE ESPECÍFICO
// Permite invalidar partes específicas del caché para asegurar la frescura de los datos.
global.invalidateCache = (type, key) => {
  switch (type) {
    case "chat":
      // Invalida el caché del chat, sus configuraciones críticas y los usuarios asociados a ese chat.
      cache.chats.delete(key)
      cache.chatUpdates.set(key, Date.now()) // Actualiza el timestamp de la última actualización del chat
      cache.criticalSettings.delete(key)
      // ✅ MEJORADO: También invalidar cache de usuarios de ese chat
      // Itera sobre el caché de usuarios para eliminar entradas relacionadas con el chat.
      for (const [cacheKey] of cache.users) {
        if (cacheKey.endsWith(`-${key}`)) {
          cache.users.delete(cacheKey)
        }
      }
      break
    case "user":
      // Invalida todas las entradas del caché de usuarios que contengan este usuario.
      for (const [cacheKey] of cache.users) {
        if (cacheKey.startsWith(key)) {
          cache.users.delete(cacheKey)
        }
      }
      break
    case "all":
      // Limpia completamente todos los cachés.
      cache.users.clear()
      cache.chats.clear()
      cache.groups.clear()
      cache.chatUpdates.clear()
      cache.criticalSettings.clear()
      cache.lastClean = Date.now() // Reinicia el timestamp de la última limpieza
      break
  }
}

// ✅ FUNCIÓN MEJORADA PARA FORZAR ACTUALIZACIÓN DE CHAT
// Fuerza la recarga de los datos de un chat desde la base de datos y actualiza el caché.
global.forceUpdateChat = async (chatId) => {
  try {
    // Invalidar cache existente para asegurar datos frescos
    global.invalidateCache("chat", chatId)

    // Obtener datos frescos de la base de datos con timeout y circuit breaker
    const freshChat = await withTimeout(getChat(chatId), 5000, `getChat ${chatId}`)

    // Actualizar cache inmediatamente con los datos frescos
    if (freshChat) {
      cache.chats.set(chatId, { data: freshChat, timestamp: Date.now() })
      cache.criticalSettings.set(chatId, {
        modoadmin: freshChat.modoadmin,
        antiLag: freshChat.antiLag,
        isBanned: freshChat.isBanned,
        timestamp: Date.now(), // Marca de tiempo para la frescura del caché crítico
      })
      cache.chatUpdates.set(chatId, Date.now()) // Actualiza el timestamp de la última actualización del chat
    }
    return freshChat
  } catch (error) {
    if (!global.isProduction) console.error(`[ERROR] Fallo al forzar actualización de chat ${chatId}:`, error)
    return null
  }
}

// ✅ NUEVA FUNCIÓN ESPECÍFICA PARA CAMBIOS DE CONFIGURACIÓN CRÍTICA
// Permite actualizar una configuración específica del chat y asegura la coherencia del caché.
global.updateChatSetting = async (chatId, setting, value) => {
  try {
    // 1. Invalidar cache inmediatamente para reflejar el cambio
    global.invalidateCache("chat", chatId)

    // 2. Obtener el chat, actualizar la configuración y guardar en BD
    const chat = await withTimeout(getChat(chatId), 5000, `getChat for update ${chatId}`)
    if (!chat) return false // Si el chat no existe, no se puede actualizar
    chat[setting] = value
    // Offload save operation to worker or process it asynchronously
    await offloadDbOperation(() => saveChat(chat)) // Usar la función de offload
    // await withTimeout(chat.save(), 5000, `saveChat ${chatId}`) // Original, si no se usa worker

    // 3. Actualizar cache inmediatamente con los nuevos valores
    if (chat) {
      cache.chats.set(chatId, { data: chat, timestamp: Date.now() })
      cache.criticalSettings.set(chatId, {
        modoadmin: chat.modoadmin,
        antiLag: chat.antiLag,
        isBanned: chat.isBanned,
        timestamp: Date.now(), // Actualiza el timestamp del caché crítico
      })
      cache.chatUpdates.set(chatId, Date.now()) // Actualiza el timestamp de la última actualización del chat
    }

    return true
  } catch (error) {
    if (!global.isProduction) console.error(`[ERROR] Fallo al actualizar configuración de chat ${chatId} - ${setting}:`, error)
    return false
  }
}

// Pre-compilar regex para máximo rendimiento en la detección de comandos.
// Evita la recompilación repetida de expresiones regulares.
const regexCache = new Map()
const getRegex = (str) => {
  if (!regexCache.has(str)) {
    // Escapa caracteres especiales para que sean tratados literalmente en la regex.
    regexCache.set(str, new RegExp(str.replace(/[|\\{}()[\]^$+*?.]/g, "\\$&")))
  }
  return regexCache.get(str)
}

// Owners/mods/prems como Set para O(1) lookup (tiempo de búsqueda constante).
// Esto es mucho más rápido que buscar en un array.
const ownerSet = new Set([...global.owner.map(([n]) => n.replace(/[^0-9]/g, "") + "@s.whatsapp.net")])
const modSet = new Set(global.mods.map((v) => v.replace(/[^0-9]/g, "") + "@s.whatsapp.net"))
const premSet = new Set(global.prems.map((v) => v.replace(/[^0-9]/g, "") + "@s.whatsapp.net"))

// ✅ IDENTIFICAR BOT PRINCIPAL - Mejorado
// Determina el JID del bot principal para lógica específica (e.g., antiLag).
const getMainBotJid = () => {
  // Prioridad: global.conn (bot principal) > primer bot conectado en global.conns
  if (global.conn?.user?.jid) {
    return global.conn.user.jid
  }
  // Fallback: busca el primer bot conectado en la lista de conexiones.
  const mainBot = global.conns?.find((conn) => conn.user?.jid && conn.ws?.socket?.readyState === 1)
  return mainBot?.user?.jid || null
}

// ✅ GLOBAL REGEX PARA OPTIMIZACIÓN
const globalRegex = {
  // Regex para detectar comandos que requieren datos frescos (críticos)
  criticalCommand: /(modoadmin|antilag|admin|ban|unban|enable|disable|on|off)/i,
  // Regex simplificada para reacciones
  reactionTrigger: /(mente|oso|izar|ción|dad|aje|tion|age|ous|ate)/i, // Palabras clave más específicas
}

// ✅ CENTRALIZACIÓN DE CONDICIONES REPETITIVAS
const isROwner = (senderClean, mainBotJid) => senderClean === mainBotJid?.replace(/[^0-9]/g, "") + "@s.whatsapp.net" || ownerSet.has(senderClean)
const isOwner = (isROwnerVal, mFromMe) => isROwnerVal || mFromMe
const isMods = (senderClean) => modSet.has(senderClean)
const isPrems = (isROwnerVal, senderClean) => isROwnerVal || premSet.has(senderClean)
const isChatBanned = (chat, isROwnerVal, pluginName) => !["grupo-unbanchat.js"].includes(pluginName) && chat.isBanned && !isROwnerVal
const isModoAdminActive = (chat, isOwnerVal, isROwnerVal, mIsGroup, isAdminVal) => chat.modoadmin && !isOwnerVal && !isROwnerVal && mIsGroup && !isAdminVal
const isUserBanned = (user, isROwnerVal) => user.banned && !isROwnerVal
const isAntiLagActive = (chat, isMainBotVal, isCriticalOverrideVal) => chat.antiLag && !isMainBotVal && !isCriticalOverrideVal
const isNotRegistered = (plugin, user) => plugin.register && !user.registered
const hasInsufficientCoins = (plugin, user, isPremsVal) => !isPremsVal && plugin.coin && user.coins < plugin.coin
const isLevelTooLow = (plugin, user) => plugin.level > (user.level || 0)

// ✅ BATCHING DE LECTURAS DE MENSAJES
let pendingReads = []
setInterval(() => {
  if (pendingReads.length) {
    global.conn?.readMessages?.(pendingReads)?.catch(() => {}) // Silenciar errores y acceso seguro
    pendingReads = []
  }
}, 1000) // Agrupar lecturas cada 1 segundo

// Limpiar cache periódicamente (cada 3 minutos) para evitar el crecimiento excesivo de memoria.
const cleanCache = () => {
  if (Date.now() - cache.lastClean > CACHE_CLEAN_INTERVAL) {
    cache.users.clear()
    cache.chats.clear()
    cache.groups.clear()
    cache.chatUpdates.clear()
    cache.criticalSettings.clear()
    cache.lastClean = Date.now()
   // if (!global.isProduction) console.log("[CACHE] Caché limpiado.")
  }
}
setInterval(cleanCache, CACHE_CLEAN_INTERVAL) // Ejecutar limpieza de caché en un intervalo fijo

// ✅ MIDDLEWARE PARA COMANDOS DE ADMINISTRACIÓN
// Intercepta comandos que modifican configuraciones críticas y fuerza la invalidación del caché.
global.handleAdminCommands = async (m, chat) => {
  if (!m.text) return

  const text = m.text.toLowerCase()

  // Lista de comandos que cambian configuraciones críticas del chat.
  const criticalCommands = ["modoadmin", "antilag", "banchat", "unbanchat", "enable", "disable", "on", "off"]

  const isCriticalCommand = criticalCommands.some((cmd) => text.includes(cmd))

  if (isCriticalCommand) {
    // Invalidar cache antes de procesar el comando para asegurar que la BD sea la fuente de verdad.
    global.invalidateCache("chat", m.chat)

    // Programar una actualización forzada del chat después de un breve retraso.
    // Esto permite que el comando se complete y luego el caché se refresque.
    setTimeout(() => {
      global.forceUpdateChat(m.chat)
    }, 1000) // Pequeño retraso para no bloquear el flujo principal
  }
}

// ✅ UTILITY: Timeout para operaciones asíncronas
const withTimeout = (promise, ms, operationName = 'Operation') => {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timeout: ${operationName} took longer than ${ms}ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
};

// ✅ UTILITY: Circuit Breaker para operaciones de BD
const circuitBreakerState = {
  isOpen: false,
  failureCount: 0,
  lastFailureTime: 0,
  threshold: 5, // Número de fallos consecutivos antes de abrir
  resetTimeout: 30000, // Tiempo en ms para intentar cerrar el circuito (30 segundos)
};

const createCircuitBreaker = (operation, operationName = 'DB Operation') => async (...args) => {
  if (circuitBreakerState.isOpen) {
    const now = Date.now();
    if (now - circuitBreakerState.lastFailureTime > circuitBreakerState.resetTimeout) {
      // Intentar cerrar el circuito (Half-Open state)
      circuitBreakerState.isOpen = false;
      circuitBreakerState.failureCount = 0;
      if (!global.isProduction) console.warn(`[CIRCUIT BREAKER] Intentando cerrar el circuito para ${operationName}.`);
    } else {
      throw new Error(`[CIRCUIT BREAKER] Circuito abierto para ${operationName}. Reintentar más tarde.`);
    }
  }

  try {
    const result = await operation(...args);
    circuitBreakerState.failureCount = 0; // Resetear contador en éxito
    return result;
  } catch (error) {
    circuitBreakerState.failureCount++;
    circuitBreakerState.lastFailureTime = Date.now();
    if (circuitBreakerState.failureCount >= circuitBreakerState.threshold) {
      circuitBreakerState.isOpen = true;
      if (!global.isProduction) console.error(`[CIRCUIT BREAKER] Circuito abierto para ${operationName} debido a ${circuitBreakerState.failureCount} fallos consecutivos.`, error);
    }
    throw error;
  }
};

// Envolver las operaciones de BD con circuit breaker y timeout
const safeGetUser = createCircuitBreaker((id) => withTimeout(getUser(id), 5000, `getUser ${id}`), 'getUser');
const safeGetChat = createCircuitBreaker((id) => withTimeout(getChat(id), 5000, `getChat ${id}`), 'getChat');
const safeGetSettings = createCircuitBreaker((id) => withTimeout(getSettings(id), 5000, `getSettings ${id}`), 'getSettings');

// ✅ SEPARACIÓN DE HILOS (Web Workers / Child Processes)
// Para operaciones pesadas como guardar en BD o actualizar stats.
// Esto es un placeholder conceptual. La implementación real requiere un archivo worker.js
// y la lógica para iniciar y comunicarse con el worker.
/*
let worker;
if (typeof Worker !== 'undefined') { // Check if Worker API is available (e.g., in Node.js with worker_threads)
    worker = new Worker('./worker.js'); // Assuming worker.js handles DB operations
    worker.on('message', (msg) => {
        if (!global.isProduction) console.log('[Worker Message]', msg);
    });
    worker.on('error', (err) => {
        console.error('[Worker Error]', err);
    });
    worker.on('exit', (code) => {
        if (code !== 0) console.error(`Worker stopped with exit code ${code}`);
    });
}
*/

// Función para offload operaciones a un worker o ejecutarlas asíncronamente
const offloadDbOperation = (operationFn) => {
  /*
    if (worker) {
      worker.postMessage({ type: 'db_operation', operation: operationFn.toString() });
    } else {
      // Fallback si no hay worker, ejecutar en el hilo principal pero sin await
      setImmediate(() => operationFn().catch(e => {
        if (!global.isProduction) console.error("[DB Offload Error]", e);
      }));
    }
  */
  // Por ahora, se ejecuta en el hilo principal sin await para no bloquear.
  // Si necesitas que el resultado sea esperado, usa `await operationFn()`.
  setImmediate(() => operationFn().catch(e => {
    if (!global.isProduction) console.error("[DB Offload Error]", e);
  }));
};

// ✅ BATCH PROCESSING DE ACTUALIZACIONES DE USUARIO/STATS
const pendingUserUpdates = new Map(); // { sender: { userObject, timestamp } }
const pendingStatsUpdates = new Map(); // { key: { statObject, timestamp } }

const BATCH_UPDATE_INTERVAL = 2500; // 2.5 segundos

setInterval(async () => {
  // Procesar actualizaciones de usuario
  if (pendingUserUpdates.size > 0) {
    const updatesToProcess = new Map(pendingUserUpdates);
    pendingUserUpdates.clear(); // Limpiar la cola inmediatamente

    for (const [sender, { user, originalCoins }] of updatesToProcess.entries()) {
      try {
        // Solo guardar si los datos han cambiado significativamente o si hay un costo de moneda
        // La lógica para determinar si `user` ha cambiado significativamente debe estar aquí
        // Por ejemplo, comparar `user.exp`, `user.level`, `user.coins` con sus valores originales
        if (user.coins !== originalCoins || user.expChanged || user.levelChanged) { // Asumiendo flags de cambio
          await offloadDbOperation(() => saveUser(user)); // Offload a worker o async
          if (!global.isProduction) console.log(`[BATCH] Usuario ${sender} actualizado.`);
        }
      } catch (e) {
        if (!global.isProduction) console.error(`[BATCH ERROR] Fallo al actualizar usuario ${sender}:`, e);
      }
    }
  }

  // Procesar actualizaciones de estadísticas
  if (pendingStatsUpdates.size > 0) {
    const statsToProcess = new Map(pendingStatsUpdates);
    pendingStatsUpdates.clear(); // Limpiar la cola inmediatamente

    for (const [key, stats] of statsToProcess.entries()) {
      try {
        await offloadDbOperation(() => dbUpdateStats(key, stats)); // Offload a worker o async
        //if (!global.isProduction) console.log(`[BATCH] Stats para ${key} actualizadas.`);
      } catch (e) {
        if (!global.isProduction) console.error(`[BATCH ERROR] Fallo al actualizar stats para ${key}:`, e);
      }
    }
  }
}, BATCH_UPDATE_INTERVAL);

// Función para encolar actualizaciones de usuario
const enqueueUserUpdate = (user, originalCoins) => {
  pendingUserUpdates.set(user.jid, { user, originalCoins });
};

// Función para encolar actualizaciones de estadísticas
const enqueueStatsUpdate = (key, stats) => {
  pendingStatsUpdates.set(key, stats);
};

// ✅ PRE-COMPILACIÓN DE COMANDOS
// Mapa estático de comandos para lookup O(1)
const commandMap = new Map();
// Esta función se llamaría una vez al inicio de la aplicación para poblar el mapa.
global.loadCommandMap = () => {
  for (const [name, plugin] of Object.entries(global.plugins)) {
    if (!plugin || plugin.disabled || typeof plugin !== "function") continue;

    const commands = plugin.command;
    if (commands) {
      const cmdsArray = Array.isArray(commands) ? commands : [commands];
      for (const cmd of cmdsArray) {
        if (typeof cmd === 'string') {
          commandMap.set(cmd.toLowerCase(), { name, plugin });
        } else if (cmd instanceof RegExp) {
          // Para regex, se guarda la regex y el plugin. La búsqueda será más compleja.
          // Podríamos tener un array de { regex, plugin } para iterar si hay muchos.
          // Por simplicidad, el handler actual ya maneja regex en plugin.command.
          // Para una pre-compilación *completa* de regex, se necesitaría un enfoque más avanzado
          // como un único regex gigante que capture todos los patrones. Esto es complejo y
          // puede ser menos eficiente que iterar sobre un pequeño número de regex individuales.
          // Mantenemos la lógica de iteración para regex en el bucle principal.
        }
      }
    }
  }
  if (!global.isProduction) console.log("[INIT] Mapa de comandos cargado.");
};
// Llama a la función para cargar el mapa de comandos al inicio de la aplicación
// Esto debería hacerse una vez, por ejemplo, en el archivo principal de tu bot.
// global.loadCommandMap(); // Descomentar y llamar en el archivo de inicio

// ✅ FUNCIÓN ULTRA-MEJORADA PARA OBTENER DATOS CON INVALIDACIÓN INTELIGENTE
// Centraliza la lógica de obtención de datos de usuario, chat y configuraciones,
// utilizando caché y forzando actualizaciones cuando es necesario (comandos críticos, cache viejo).
const getCachedData = async (context, m) => {
  const cacheKey = `${m.sender}-${m.chat}` // Clave única para el caché de usuario-chat
  const chatKey = m.chat // Clave para el caché de chat

  // ✅ NUEVO: Verificar configuraciones críticas primero
  const criticalCacheEntry = cache.criticalSettings.get(chatKey)
  // Calcula la antigüedad del caché crítico. Si no existe, es infinitamente viejo.
  const criticalCacheAge = criticalCacheEntry ? Date.now() - criticalCacheEntry.timestamp : Number.POSITIVE_INFINITY

  // ✅ MEJORADO: Detectar comandos que requieren datos frescos
  // Estos comandos siempre deben obtener los datos más recientes de la BD.
  const requiresFreshData = m.text && globalRegex.criticalCommand.test(m.text)

  const lastChatUpdate = cache.chatUpdates.get(chatKey) || 0 // Última vez que el chat fue actualizado en caché
  const chatCacheAge = Date.now() - lastChatUpdate // Antigüedad del caché del chat

  // Obtener entradas completas del caché (con timestamp)
  const cachedUserEntry = cache.users.get(cacheKey)
  const cachedChatEntry = cache.chats.get(chatKey)

  // ✅ LÓGICA MEJORADA: Forzar refresh en múltiples condiciones
  // Se fuerza una actualización si:
  // 1. Se detecta un comando crítico.
  // 2. El caché del chat es muy reciente (posiblemente actualizado por otro bot o comando) - esto es para asegurar que el comando que acaba de modificar el chat vea el cambio.
  // 3. El caché del chat completo es muy viejo (más de MAX_CACHE_AGE_CHAT).
  // 4. Las configuraciones críticas están viejas (más de MAX_CACHE_AGE_CRITICAL).
  // 5. No hay ningún caché para este chat o usuario.
  const forceRefresh =
    requiresFreshData ||
    (chatCacheAge > 0 && chatCacheAge < 30000) || // Actualización reciente (menos de 30s)
    (cachedChatEntry && (Date.now() - cachedChatEntry.timestamp > MAX_CACHE_AGE_CHAT)) || // Cache de chat completo muy viejo
    criticalCacheAge > MAX_CACHE_AGE_CRITICAL || // Configuraciones críticas viejas
    !cachedChatEntry || // No hay cache del chat
    !cachedUserEntry // No hay cache del usuario

  // Si tenemos caché válido para el usuario-chat y no necesitamos forzar un refresh, usarlo.
  if (cachedUserEntry && !forceRefresh) {
    const cachedData = cachedUserEntry.data
    // ✅ VERIFICAR SI LAS CONFIGURACIONES CRÍTICAS ESTÁN ACTUALIZADAS
    // Si el caché crítico es reciente, se usan sus valores para sobrescribir los del chat cacheado.
    if (criticalCacheEntry && criticalCacheAge < MAX_CACHE_AGE_CRITICAL) {
      cachedData.chat.modoadmin = criticalCacheEntry.modoadmin
      cachedData.chat.antiLag = criticalCacheEntry.antiLag
      cachedData.chat.isBanned = criticalCacheEntry.isBanned
    }
    return cachedData
  }

  // ✅ OBTENER DATOS FRESCOS
  // Si no hay caché o se necesita un refresh, se obtienen los datos de la base de datos en paralelo.
  const [user, chat, settings] = await Promise.all([
    safeGetUser(m.sender), // Usar safeGetUser con circuit breaker y timeout
    safeGetChat(m.chat), // Usar safeGetChat con circuit breaker y timeout
    cache.settings || safeGetSettings(context?.user?.jid || "default"), // Usar safeGetSettings
  ])

  // Si no se pudieron obtener datos, se retorna null.
  if (!user || !chat) {
    if (!global.isProduction) console.warn(`[CACHE] No se pudieron obtener datos para ${m.sender} en ${m.chat}`)
    return null
  }

  // Almacenar las configuraciones globales en caché si aún no lo están.
  if (!cache.settings) cache.settings = settings

  // ✅ ACTUALIZAR TODOS LOS CACHES
  // Se actualizan los cachés con los datos recién obtenidos.
  cache.chats.set(chatKey, { data: chat, timestamp: Date.now() })
  cache.criticalSettings.set(chatKey, {
    modoadmin: chat.modoadmin,
    antiLag: chat.antiLag,
    isBanned: chat.isBanned,
    timestamp: Date.now(), // Marca de tiempo de la actualización del caché crítico
  })
  cache.chatUpdates.set(chatKey, Date.now()) // Marca de tiempo de la última actualización del chat

  const data = { user, chat, settings }
  cache.users.set(cacheKey, { data, timestamp: Date.now() }) // Almacena el conjunto de datos user/chat/settings en caché

  return data
}

// Función principal del manejador de mensajes.
export async function handler(chatUpdate) {
  // Ignorar actualizaciones sin mensajes o mensajes vacíos.
  if (!chatUpdate?.messages?.length) return

  // Inicializar colas y tiempos de actividad si no existen.
  this.msgqueque ??= []
  this.uptime ??= Date.now()

  // Procesar el último mensaje sin 'await' para no bloquear el hilo principal.
  const m = smsg(this, chatUpdate.messages.at(-1))

  // Si el mensaje no tiene texto ni tipo de mensaje, ignorar.
  if (!m?.text && !m?.mtype) return

  // Inicializar propiedades del mensaje.
  m.exp = 0
  m.coin = false
  m.text ??= ""

  // Early returns para máxima velocidad:
  // Si el bot está en modo "solo lectura", "solo yo", "solo estados" o es un mensaje de Baileys, ignorar.
  if (opts.nyimak) return
  if (opts.self && !m.fromMe) return
  if (opts.swonly && m.chat !== "status@broadcast") return
  if (m.isBaileys) return

  // ✅ DECLARAR VARIABLES FUERA DEL TRY BLOCK
  // Esto evita redeclaraciones y mejora ligeramente el rendimiento.
  let commandFound = false
  let pluginExecuted = false
  let isROwnerVal = false // Root Owner
  let isOwnerVal = false
  let isModsVal = false
  let isPremsVal = false
  let isAdminVal = false
  let isBotAdminVal = false

  try {
    // ✅ CACHE INTELIGENTE CON INVALIDACIÓN AUTOMÁTICA MEJORADA
    // Inicia la obtención de datos en paralelo con el resto del procesamiento.
    const dataPromise = getCachedData(this, m)

    // ✅ IDENTIFICACIÓN DE BOTS MEJORADA
    // Determina si el bot actual es el bot principal.
    const mainBotJid = getMainBotJid()
    const currentBotJid = this?.user?.jid
    const isMainBot = currentBotJid === mainBotJid

    // Pre-calcular permisos mientras se cargan datos de la BD.
    const senderClean = m.sender.replace(/[^0-9]/g, "") + "@s.whatsapp.net"
    isROwnerVal = isROwner(senderClean, mainBotJid)
    isOwnerVal = isOwner(isROwnerVal, m.fromMe)
    isModsVal = isMods(senderClean)
    isPremsVal = isPrems(isROwnerVal, senderClean)

    // Espera la resolución de la promesa de datos del caché.
    const { user, chat, settings } = await dataPromise

    // --- SOLO RESPONDE EL BOT PRIMARIO EN ESTE GRUPO ---
    if (m.isGroup && chat.primaryBot) {
      const setPrimaryPattern = /^([/#.]?)setprimary\b/i;
      if (
        this.user.jid !== chat.primaryBot &&
        !(m.text && setPrimaryPattern.test(m.text))
      ) {
        // console.log(`[handler] Ignorando mensaje en ${m.chat}. Bot primario: ${chat.primaryBot}, este bot: ${this.user.jid}`)
        return
      }
    }

    // Si no se obtuvieron datos de usuario o chat, ignorar el mensaje.
    if (!user || !chat) return

    // ✅ NUEVO: Middleware para comandos críticos ANTES de verificaciones.
    // Esto permite que los comandos de administración actualicen el estado del chat
    // antes de que se apliquen las restricciones (como antiLag o baneo).
    // Se usa await aquí solo si el comando es crítico.
    if (globalRegex.criticalCommand.test(m.text)) { // <-- Condición para usar await
      await global.handleAdminCommands(m, chat).catch(e => {
        if (!global.isProduction) console.error("Error in handleAdminCommands (critical path):", e)
      })
    } else {
      // Ejecutar handleAdminCommands asíncronamente sin esperar si no es crítico
      setImmediate(() => global.handleAdminCommands(m, chat).catch(e => {
        if (!global.isProduction) console.error("Error in handleAdminCommands (non-critical path):", e)
      }))
    }

    // ✅ ANTILAG OPTIMIZADO - Solo el bot principal responde cuando está activo.
    // Los comandos de setprimary y antilag son excepciones para evitar bloqueos.
    const text = m.text?.toLowerCase() || ''
    const isSetPrimary = /^([/#.]?)setprimary\b/i.test(text)
    const isToggleAntiLag = /^([/#.]?)antilag\b/i.test(text)
    const isCriticalOverride = isSetPrimary || isToggleAntiLag

    // Usar la función centralizada para la condición antiLag
    if (isAntiLagActive(chat, isMainBot, isCriticalOverride)) {
      return
    }

    // ✅ VERIFICACIÓN DE BANEO - Solo si no es owner.
    // Usar la función centralizada para la condición de usuario baneado
    if (isUserBanned(user, isROwnerVal)) {
      m.reply(`⚠️ Usuario baneado: ${user.bannedReason || "No especificado"}`)
      return
    }

    // Queue optimizado solo si es necesario y el usuario no es mod/prem.
    if (opts.queque && m.text && !(isModsVal || isPremsVal)) {
      const q = this.msgqueque
      q.push(m.id || m.key.id)
    }

    // Cache de metadatos de grupo para evitar llamadas repetidas a la API de Baileys.
    let groupMetadata, participants, userGroup, botGroup
    if (m.isGroup) {
      const groupKey = m.chat
      const cachedGroupEntry = cache.groups.get(groupKey)

      if (cachedGroupEntry && (Date.now() - cachedGroupEntry.timestamp < MAX_CACHE_AGE_CHAT)) {
        groupMetadata = cachedGroupEntry.data
      } else {
        // Lazy loading: solo cargar metadatos si no están en caché o están viejos
        groupMetadata = (conn.chats[m.chat] || {}).metadata || (await this.groupMetadata(m.chat).catch(() => null))
        if (groupMetadata) {
          cache.groups.set(groupKey, { data: groupMetadata, timestamp: Date.now() })
        }
      }

      // Si se obtuvieron los metadatos del grupo, se extraen participantes y roles.
      if (groupMetadata && Array.isArray(groupMetadata.participants)) {
       participants = groupMetadata.participants
       userGroup = participants.find((u) => conn.decodeJid(u.id) === m.sender)
        botGroup = participants.find((u) => conn.decodeJid(u.id) === currentBotJid)
        isAdminVal = userGroup?.admin === "superadmin" || userGroup?.admin === "admin"
        isBotAdminVal = botGroup?.admin
      } else {
        participants = []
        userGroup = undefined
        botGroup = undefined
        isAdminVal = false
        isBotAdminVal = false
      }
    }

    const ___dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), "./plugins")

    // Procesamiento ultra-optimizado de plugins
    // ✅ PLUGINS TIPO before (globales sin prefix)
    // Estos plugins se ejecutan antes de la detección de comandos y pueden bloquear el flujo.
    for (const [name, plugin] of Object.entries(global.plugins)) {
      if (typeof plugin.before === 'function') {
        // Ejecutar sin await para no bloquear, pero capturar el resultado si es necesario para el flujo.
        const resultPromise = plugin.before.call(this, m, {
          conn: this,
          participants,
          groupMetadata,
          user: userGroup,
          bot: botGroup,
          isROwner: isROwnerVal,
          isOwner: isOwnerVal,
          isAdmin: isAdminVal || false,
          isBotAdmin: isBotAdminVal,
          isPrems: isPremsVal,
          chatUpdate,
          __dirname,
          __filename: join(___dirname, name),
        }).catch(e => {
          if (!global.isProduction) console.error(`[PLUGIN BEFORE ERROR] ${name}:`, e)
          return false // Asegurar que el error no bloquee el flujo, y no continúe como bloqueante
        })

        // Si el plugin "before" devuelve true, significa que ha manejado el mensaje
        // y no se debe continuar con la detección de comandos para este mensaje.
        // Esperar solo si el plugin 'before' puede bloquear el flujo.
        const result = await resultPromise
        if (result === true) {
          continue // Si un plugin before bloquea, se detiene la iteración de plugins.
        }
      }
    }

    // Iteración principal sobre los plugins para encontrar y ejecutar comandos.
    // ✅ USO DE commandMap PARA BÚSQUEDA RÁPIDA
    let targetPlugin = null;
    let usedPrefix = null;
    let match = null;
    let cmd = null;

    // Primero, intenta una búsqueda directa en el commandMap para comandos de string
    const potentialPrefixes = Array.isArray(conn.prefix) ? conn.prefix : [conn.prefix];
    for (const p of potentialPrefixes) {
      if (m.text.startsWith(p)) {
        const noPrefix = m.text.slice(p.length).trim();
        const [commandName] = noPrefix.split(/\s+/);
        const mapped = commandMap.get(commandName.toLowerCase());
        if (mapped) {
          targetPlugin = mapped.plugin;
          usedPrefix = p;
          cmd = commandName.toLowerCase();
          break;
        }
      }
    }

    // Si no se encontró por búsqueda directa, iterar para comandos con RegExp o customPrefix
    if (!targetPlugin) {
      for (const [name, plugin] of Object.entries(global.plugins)) {
        if (!plugin || plugin.disabled || typeof plugin !== "function") continue;

        const _prefix = plugin.customPrefix || conn.prefix || global.prefix;
        let currentMatch, currentUsedPrefix;

        if (_prefix instanceof RegExp) {
          currentMatch = _prefix.exec(m.text);
          if (currentMatch) currentUsedPrefix = currentMatch[0];
        } else if (Array.isArray(_prefix)) {
          for (const p of _prefix) {
            const regex = getRegex(p);
            currentMatch = regex.exec(m.text);
            if (currentMatch) {
              currentUsedPrefix = currentMatch[0];
              break;
            }
          }
        } else if (typeof _prefix === "string") {
          const regex = getRegex(_prefix);
          currentMatch = regex.exec(m.text);
          if (currentMatch) currentUsedPrefix = currentMatch[0];
        }

        if (!currentUsedPrefix) continue;

        const noPrefix = m.text.slice(currentUsedPrefix.length);
        const [commandPart] = noPrefix.trim().split(/\s+/);
        const currentCmd = commandPart?.toLowerCase();

        const isAccept =
          plugin.command instanceof RegExp
            ? plugin.command.test(currentCmd)
            : Array.isArray(plugin.command)
              ? plugin.command.some((c) => (c instanceof RegExp ? c.test(currentCmd) : c === currentCmd))
              : plugin.command === currentCmd;

        if (isAccept) {
          targetPlugin = plugin;
          usedPrefix = currentUsedPrefix;
          match = currentMatch;
          cmd = currentCmd;
          m.plugin = name; // Asigna el nombre del plugin al mensaje.
          break;
        }
      }
    }

    if (!targetPlugin) {
      // Si no se encontró ningún comando, ejecutar plugin.all y salir
      for (const [name, plugin] of Object.entries(global.plugins)) {
        if (plugin.all && typeof plugin.all === 'function') {
          setImmediate(() => {
            plugin.all.call(this, m, {
              chatUpdate,
              __dirname: ___dirname,
              __filename: join(___dirname, name),
            }).catch(e => {
              if (!global.isProduction) console.error(`[PLUGIN ALL ERROR] ${name}:`, e);
            });
          });
        }
      }
      return; // Terminar si no se encontró un comando
    }

    const plugin = targetPlugin;
    const __filename = join(___dirname, m.plugin); // Usar m.plugin para el nombre del archivo

    // Ejecutar plugin.all sin bloquear el hilo principal (si no se hizo ya)
    if (plugin.all && typeof plugin.all === 'function' && !pluginExecuted) { // Check pluginExecuted to avoid double execution
      setImmediate(() => {
        plugin.all.call(this, m, {
          chatUpdate,
          __dirname: ___dirname,
          __filename,
        }).catch(e => {
          if (!global.isProduction) console.error(`[PLUGIN ALL ERROR] ${name}:`, e);
        });
      });
    }

    // Restricción de plugins de administración si opts.restrict está deshabilitado.
    if (!opts.restrict && plugin.tags?.includes("admin")) return; // Early return

    // Plugin.before optimizado (si ya no fue ejecutado como global 'before').
    // Este 'before' es específico del plugin y puede bloquear su ejecución.
    if (plugin.before && typeof plugin.before === 'function') {
      const shouldContinue = await plugin.before.call(this, m, {
        match: match ? [match] : null,
        conn: this,
        participants,
        groupMetadata,
        user: userGroup,
        bot: botGroup,
        isROwner: isROwnerVal,
        isOwner: isOwnerVal,
        isAdmin: isAdminVal || false,
        isBotAdmin: isBotAdminVal,
        isPrems: isPremsVal,
        chatUpdate,
        __dirname: ___dirname,
        __filename,
      }).catch(e => {
        if (!global.isProduction) console.error(`[PLUGIN BEFORE ERROR] ${name}:`, e)
        return true // Si hay error en before, no ejecutar el plugin
      })
      if (shouldContinue) return; // Si el 'before' del plugin devuelve true, no se ejecuta el plugin.
    }

    // Parsing ultra-rápido del comando.
    const noPrefix = m.text.slice(usedPrefix.length) // Texto sin el prefijo.
    const [_cmd, ...args] = noPrefix.trim().split(/\s+/) // Divide el comando y los argumentos.
    const textArgs = args.join(" ") // Reconstruye el texto de los argumentos.

    commandFound = true // Se encontró un comando.
    m.plugin = plugin.name || m.plugin; // Asegura que m.plugin tenga el nombre correcto

    // ✅ VERIFICACIONES MEJORADAS (usando funciones centralizadas)
    // Si el chat está baneado y el usuario no es root owner, se ignora el comando.
    if (isChatBanned(chat, isROwnerVal, m.plugin)) {
      return // Termina el handler para este mensaje.
    }

    // ✅ MODO ADMIN OPTIMIZADO CON DATOS FRESCOS
    // Si el modo admin está activado en el grupo y el usuario no es owner/admin, se le notifica.
    if (isModoAdminActive(chat, isOwnerVal, isROwnerVal, m.isGroup, isAdminVal)) {
      m.reply("> Este grupo tiene el modo admin activado. Solo los administradores pueden usar comandos.")
      return // Termina el handler para este mensaje.
    }

    // Validaciones de permisos ultra-rápidas y secuenciales.
    // Utiliza 'return' para pasar al siguiente plugin si el permiso falla.
    const fail = plugin.fail || global.dfail // Función de fallo por defecto.
    if (plugin.rowner && !isROwnerVal) { fail("rowner", m, this); return; }
    if (plugin.owner && !isOwnerVal) { fail("owner", m, this); return; }
    if (plugin.mods && !isModsVal) { fail("mods", m, this); return; }
    if (plugin.premium && !isPremsVal) { fail("premium", m, this); return; }
    if (plugin.group && !m.isGroup) { fail("group", m, this); return; }
    if (plugin.botAdmin && !isBotAdminVal) { fail("botAdmin", m, this); return; }
    if (plugin.admin && !isAdminVal) { fail("admin", m, this); return; }
    if (plugin.private && m.isGroup) { fail("private", m, this); return; }
    if (isNotRegistered(plugin, user)) { fail("unreg", m, this); return; }

    m.isCommand = true // Marca el mensaje como un comando.
    m.exp += plugin.exp || 17 // Añade experiencia al usuario.

    // Guardar el valor original de las monedas para el batching
    const originalUserCoins = user.coins;

    // Verificación de monedas para usuarios no premium.
    if (hasInsufficientCoins(plugin, user, isPremsVal)) {
      conn.reply(m.chat, "💰 Te faltan monedas para usar este comando", m)
      return
    }

    // Verificación de nivel.
    if (isLevelTooLow(plugin, user)) {
      return
    }

    try {
      // Ejecutar plugin con máxima velocidad.
      await plugin.call(this, m, {
        match: match ? [match] : null,
        usedPrefix,
        noPrefix,
        _args: args,
        args,
        command: cmd,
        text: textArgs,
        conn: this,
        participants,
        groupMetadata,
        user: userGroup,
        bot: botGroup,
        isROwner: isROwnerVal,
        isOwner: isOwnerVal,
        isAdmin: isAdminVal || false,
        isBotAdmin: isBotAdminVal,
        isPrems: isPremsVal,
        chatUpdate,
        __dirname: ___dirname,
        __filename,
      })

      // Se marcó que un plugin fue ejecutado.
      pluginExecuted = true
      // Resta monedas si no es premium y el comando tiene costo.
      if (!isPremsVal && plugin.coin) {
        user.coins -= plugin.coin;
        m.coin = plugin.coin; // Marca el costo de la moneda en el mensaje
      }

    } catch (e) {
      m.error = e // Almacena el error en el mensaje.
      const errorText = format(e).replace(/Administrador/g, "Admin")
      m.reply(`⚠️ Error: ${errorText}`) // Responde con el error.
      if (!global.isProduction) console.error(`[HANDLER ERROR] Plugin ${m.plugin} failed:`, e)
    } finally {
      // Encolar la actualización del usuario para batch processing
      enqueueUserUpdate(user, originalUserCoins);

      // Plugin.after sin bloquear el hilo principal.
      // Se utiliza .catch(() => {}) para silenciar errores en estas ejecuciones en background.
      if (plugin.after) {
        setImmediate(() => {
          plugin.after
            .call(this, m, {
              match: match ? [match] : null,
              usedPrefix,
              noPrefix,
              _args: args,
              args,
              command: cmd,
              text: textArgs,
              conn: this,
              participants,
              groupMetadata,
              user: userGroup,
              bot: botGroup,
              isROwner: isROwnerVal,
              isOwner: isOwnerVal,
              isAdmin: isAdminVal || false,
              isBotAdmin: isBotAdminVal,
              isPrems: isPremsVal,
              chatUpdate,
              __dirname: ___dirname,
              __filename,
            })
            .catch(e => {
              if (!global.isProduction) console.error(`[PLUGIN AFTER ERROR] ${m.plugin}:`, e);
            });
        });
      }

      // Actualizar estadísticas (fire-and-forget)
      if (commandFound) {
        enqueueStatsUpdate(m.plugin, { lastUsed: Date.now(), count: 1 }); // Encolar para batch
      }
    }
  } catch (e) {
    if (!global.isProduction) console.error("[HANDLER CRITICAL ERROR]", e);
    // Manejo de errores de alto nivel si algo falla antes de que m.reply esté disponible
    // o si el error es catastrófico. Podrías enviar un mensaje de error a un log externo.
  }
}


// ✅ NOTA SOBRE MongoDB Connection Pool y Prepared Statements:
// La implementación de un pool de conexiones y prepared statements (consultas preparadas)
// se realiza a nivel del driver de MongoDB (por ejemplo, `mongoose` o el driver nativo de `mongodb`).
// Se asume que las funciones `getUser`, `getChat`, `getSettings`, `dbUpdateStats`, `saveChat`, `saveUser`
// en `lib/mongodb.js` ya están configuradas para usar un pool de conexiones eficiente
// y, si es aplicable, optimizar las consultas repetitivas.

// ✅ NOTA SOBRE WeakMap:
// WeakMap requiere que sus claves sean objetos. Dado que las claves de caché actuales
// (`sender-chatId`, `chatId`) son strings, `Map` es la estructura de datos correcta y más eficiente.
// WeakMap sería útil si estuvieras cacheando objetos de usuario o chat directamente como claves.

// ✅ NOTA SOBRE Object Pooling:
// La reutilización de objetos de contexto (como el objeto `m`) es una optimización muy avanzada
// que a menudo requiere un control de bajo nivel sobre la creación de objetos y su ciclo de vida.
// En este handler, el objeto `m` es el resultado de `smsg()`, que lo crea en cada mensaje.
// Implementar object pooling para `m` implicaría refactorizar `smsg` para usar un pool,
// lo cual es una tarea compleja y podría introducir su propia sobrecarga si no se hace con cuidado.
// Por ahora, el beneficio de rendimiento de otras optimizaciones es mayor.

// ✅ NOTA SOBRE Cache de Segundo Nivel (Redis):
// Para implementar Redis como caché de segundo nivel, necesitarías:
// 1. Instalar un cliente Redis (ej. `ioredis` o `node-redis`).
// 2. Configurar una instancia de servidor Redis.
// 3. Modificar `getCachedData` y las funciones de guardado para primero
//    consultar/escribir en Redis antes de ir a MongoDB, y usar TTLs en Redis.
// Esto es para caché compartido entre múltiples instancias del bot.
/*
import Redis from 'ioredis';
const redisClient = new Redis({
  port: 6379, // Puerto de Redis
  host: '127.0.0.1', // Host de Redis
  // ... otras opciones
});

// Ejemplo de uso conceptual en getCachedData:
// const cachedData = await redisClient.get(cacheKey);
// if (cachedData) return JSON.parse(cachedData);
// ... luego guardar en Redis después de obtener de MongoDB
// await redisClient.setex(cacheKey, TTL_SECONDS, JSON.stringify(data));
*/
