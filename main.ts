// DenoProxy 主服务入口，Deno 版本
import { Application, Router, send } from "https://deno.land/x/oak@v12.6.1/mod.ts";
import { join, dirname, fromFileUrl } from "https://deno.land/std@0.224.0/path/mod.ts";

const __dirname = dirname(fromFileUrl(import.meta.url));
const CONFIG_FILE = join(__dirname, "index_config.json");
const PUBLIC_DIR = join(__dirname, "public");
const INDEX_FILE = join(PUBLIC_DIR, "index.html");
const FAVICON_PATH = join(PUBLIC_DIR, "favicon.ico");
const CONFIG_ENDPOINT = "/list";

// ================== 工具函数与缓存实现 ==================
function calculateUptime(establishTimeStr?: string): string {
  if (!establishTimeStr) return "未设置建站时间";
  const [year, month, day, hour, minute] = establishTimeStr.split('/').map(Number);
  const establishDate = new Date(year, month - 1, day, hour, minute);
  const now = new Date();
  const diff = now.getTime() - establishDate.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));
  const hours = Math.floor((diff % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  let uptime = "";
  if (days > 0) uptime += `${days}天`;
  if (hours > 0) uptime += `${hours}小时`;
  uptime += `${minutes}分钟`;
  return uptime;
}

function formatEstablishTime(timeStr?: string): string {
  if (!timeStr) return "未设置";
  const [year, month, day, hour, minute] = timeStr.split('/').map(Number);
  return `${year}年${month}月${day}日${hour}时${minute}分`;
}

async function loadConfig(configPath: string, fallback: any) {
  try {
    const configText = await Deno.readTextFile(configPath);
    return { ...fallback, ...JSON.parse(configText) };
  } catch (e) {
    console.error("加载配置文件失败，使用默认配置", e);
    return fallback;
  }
}

async function loadStatics(paths: { index: string, favicon: string }) {
  return Promise.all([
    Deno.readTextFile(paths.index).catch(() => null),
    Deno.readFile(paths.favicon).catch(() => null),
  ]);
}

const LOG_BUFFER_SIZE = 2000;
const logBuffer: string[] = [];

function colorize(level: string, msg: string) {
  const RESET = "\x1b[0m";
  const COLORS: Record<string, string> = {
    INFO: "\x1b[36m",
    WARN: "\x1b[33m",
    ERROR: "\x1b[31m"
  };
  return `${COLORS[level] || ''}[${level}]${RESET} ${msg}`;
}

function pushLog(msg: string, level: 'INFO' | 'WARN' | 'ERROR' = 'INFO') {
  const time = new Date().toISOString();
  const logLine = `[${time}] [${level}] ${msg}`;
  logBuffer.push(logLine);
  if (logBuffer.length > LOG_BUFFER_SIZE) logBuffer.shift();
  if (typeof Deno !== 'undefined' && Deno.noColor === false) {
    console.log(colorize(level, `[${time}] ${msg}`));
  } else {
    console.log(logLine);
  }
}

function logInfo(msg: string) { pushLog(msg, 'INFO'); }
function logWarn(msg: string) { pushLog(msg, 'WARN'); }
function logError(msg: string) { pushLog(msg, 'ERROR'); }

function parseSize(sizeStr: string | number): number {
  if (typeof sizeStr === 'number') return sizeStr;
  const match = sizeStr.match(/^(\d+)(MB|KB|B)$/i);
  if (!match) throw new Error('大小格式无效, 请使用"8MB"、"1024KB"或"1048576B"格式');
  const [, size, unit] = match;
  const multipliers = { 'B': 1, 'KB': 1024, 'MB': 1024 * 1024 };
  return parseInt(size) * multipliers[unit.toUpperCase() as keyof typeof multipliers];
}

function parseTime(timeStr: string | number): number {
  if (typeof timeStr === 'number') return timeStr;
  const match = timeStr.match(/^(\d+)S$/i);
  if (!match) throw new Error('时间格式无效, 使用"86400S"等格式');
  return parseInt(match[1]);
}

function formatSize(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)}${units[unitIndex]}`;
}

function getClientIp(ctx: any): string {
  return ctx.request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 
         ctx.request.headers.get('x-real-ip') || 
         ctx.request.ip || '';
}

// ================== 缓存系统 ==================
class MemoryCache {
  cache = new Map<string, any>();
  maxSize: number;
  currentSize = 0;
  constructor(maxSize: string | number) {
    this.maxSize = parseSize(maxSize);
  }
  
  set(key: string, value: any, size: number, maxAge?: string) {
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey) {
        this.delete(firstKey);
      }
    }
    if (size > this.maxSize) return false;
    const expiresAt = maxAge ? Date.now() + parseTime(maxAge) * 1000 : null;
    this.cache.set(key, { ...value, size, timestamp: Date.now(), expiresAt, accessCount: 1 });
    this.currentSize += size;
    return true;
  }
  
  get(key: string) {
    const item = this.cache.get(key);
    if (item) {
      if (item.expiresAt && Date.now() > item.expiresAt) {
        this.delete(key);
        return null;
      }
      item.timestamp = Date.now();
      item.accessCount = (item.accessCount || 0) + 1;
      return item;
    }
    return null;
  }
  
  delete(key: string) {
    const item = this.cache.get(key);
    if (item) {
      this.currentSize -= item.size;
      this.cache.delete(key);
    }
  }
  
  has(key: string) {
    if (!this.cache.has(key)) return false;
    const item = this.cache.get(key);
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.delete(key);
      return false;
    }
    return true;
  }
  
  getSize() { return this.currentSize; }
  clear() { this.cache.clear(); this.currentSize = 0; }
}

class Cache {
  config: any;
  cacheImpl: any;
  cacheConfig: any;
  
  constructor(config: any) {
    this.config = config;
    const cacheType = config.cache?.type || 'memory';
    const maxSize = config.cache?.maxSize || '1024MB';
    // Deno版本只实现内存缓存
    this.cacheImpl = new MemoryCache(maxSize);
    this.cacheConfig = { type: cacheType, maxSize };
  }
  
  getCacheConfig() { return this.cacheConfig; }
  
  getCacheKey(path: string) { return path; }
  
  isCacheable(ext: string, bufferLength: number) {
    const allowedTypes = this.config.cache?.imageTypes || ["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico"];
    const minSize = parseSize(this.config.cache?.minSize || "8MB");
    return allowedTypes.includes(ext) && bufferLength >= minSize;
  }
  
  async get(path: string) {
    return this.cacheImpl.get(path);
  }
  
  async set(path: string, buffer: Uint8Array, contentType: string) {
    const maxTime = this.config.cache?.maxTime;
    const cacheData = { data: buffer, contentType };
    this.cacheImpl.set(path, cacheData, buffer.length, maxTime);
  }
  
  formatSize(bytes: number) { return formatSize(bytes); }
}

function getCacheHeaders(maxAgeSeconds: number) {
  return {
    "Cache-Control": `public, max-age=${maxAgeSeconds}`,
    "CDN-Cache-Control": `max-age=${maxAgeSeconds}`,
  };
}

// ================== 配置加载 ==================
const fallbackConfig = {
  title: "MIFENG CDN代理服务",
  description: "高性能多源CDN代理解决方案",
  footer: "© 2025 Mifeng CDN服务 | 提供稳定快速的资源访问",
  proxies: []
};

// 初始化应用
const app = new Application();
const router = new Router();

// 主函数
async function main() {
  const config = await loadConfig(CONFIG_FILE, fallbackConfig);
  logInfo("配置加载完成");
  
  const [homepage, favicon] = await loadStatics({
    index: INDEX_FILE,
    favicon: FAVICON_PATH
  });
  logInfo("静态资源加载完成");
  
  const START_TIME = new Date();
  const maxAgeSeconds = config.cache?.maxTime ? parseTime(config.cache.maxTime) : 86400;
  const cacheHeaders = getCacheHeaders(maxAgeSeconds);
  const imageCache = new Cache(config);

  // ================== 基础路由 ==================
  router.get("/", (ctx) => {
    if (!homepage) {
      ctx.response.status = 503;
      ctx.response.body = "Service Unavailable";
      return;
    }
    ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
    Object.entries(cacheHeaders).forEach(([k, v]) => ctx.response.headers.set(k, v));
    ctx.response.body = homepage;
  });

  router.get("/favicon.ico", (ctx) => {
    if (!favicon) {
      ctx.response.status = 404;
      ctx.response.body = "Not Found";
      return;
    }
    ctx.response.headers.set("Content-Type", "image/x-icon");
    Object.entries(cacheHeaders).forEach(([k, v]) => ctx.response.headers.set(k, v));
    ctx.response.body = favicon;
  });

  router.get("/logs", (ctx) => {
    ctx.response.headers.set("Content-Type", "text/plain; charset=utf-8");
    ctx.response.body = logBuffer.join('\n');
  });

  router.get(CONFIG_ENDPOINT, (ctx) => {
    const uptime = calculateUptime(config.establishTime);
    const establish = formatEstablishTime(config.establishTime);
    const cacheDays = Math.floor(maxAgeSeconds / 86400);
    const host = ctx.request.url.host;
    const protocol = ctx.request.secure ? 'https' : 'http';
    
    const configInfo = {
      服务状态: "运行中",
      版本信息: "v1.0",
      运行时间: uptime,
      建站时间: establish,
      缓存时间: `${cacheDays}天`,
      服务配置: {
        服务名称: config.title,
        服务描述: config.description,
        页脚信息: config.footer
      },
      代理服务器: config.httpProxy?.enabled ? {
        启用状态: "已启用",
        代理地址: `${config.httpProxy.address}${config.httpProxy.port ? ':' + config.httpProxy.port : ''}`,
        认证信息: config.httpProxy.username ? "已配置" : "未配置"
      } : {
        启用状态: "未启用"
      },
      代理配置: config.proxies
        .filter((proxy: any) => proxy.visible !== false)
        .map((proxy: any) => ({
          代理路径: proxy.prefix,
          目标地址: proxy.target,
          代理说明: proxy.description || "未提供描述",
          重定向模板: proxy.rawRedirect || "使用默认目标URL",
          使用代理: proxy.useProxy !== false ? "是" : "否",
          使用示例: {
            代理访问: `${protocol}://${host}${proxy.prefix}`,
            直接重定向: `${protocol}://${host}${proxy.prefix}?raw=true`
          }
        }))
    };
    
    ctx.response.headers.set("Content-Type", "application/json; charset=utf-8");
    Object.entries(cacheHeaders).forEach(([k, v]) => ctx.response.headers.set(k, v));
    ctx.response.body = JSON.stringify(configInfo, null, 2);
  });

  // ================== 代理路由 ==================
  router.all("/(.*)", async (ctx) => {
    try {
      const path = ctx.request.url.pathname;
      const ip = getClientIp(ctx);
      
      logInfo(`[请求] 路径: ${path}, 方法: ${ctx.request.method}`);
      
      let proxyConfig = null;
      let basePath = path;
      for (const proxy of config.proxies) {
        if (path.startsWith(proxy.prefix)) {
          proxyConfig = proxy;
          basePath = path.slice(proxy.prefix.length);
          break;
        }
      }
      
      if (!proxyConfig) {
        logInfo(`[输出] 未匹配到代理，返回404`);
        ctx.response.status = 404;
        ctx.response.body = 'Not Found';
        return;
      }
      
      const sanitizedPath = basePath.replace(/^[\/]+/, "").replace(/\|/g, "").replace(/[\/]+/g, "/");
      const targetUrl = new URL(sanitizedPath, proxyConfig.target);
      
      // 处理URL参数
      const searchParams = ctx.request.url.searchParams;
      for (const [key, value] of searchParams.entries()) {
        if (key !== "raw") {
          targetUrl.searchParams.append(key, value);
        }
      }
      
      logInfo(`[代理] 目标URL: ${targetUrl}`);
      
      if (searchParams.get("raw") === "true") {
        let redirectUrl;
        if (proxyConfig.rawRedirect) {
          redirectUrl = proxyConfig.rawRedirect.replace("{path}", sanitizedPath);
          
          const params = new URLSearchParams();
          for (const [key, value] of searchParams.entries()) {
            if (key !== "raw") params.append(key, value);
          }
          
          if (params.toString()) {
            redirectUrl += (redirectUrl.includes('?') ? '&' : '?') + params.toString();
          }
        } else {
          redirectUrl = targetUrl.toString();
        }
        
        ctx.response.redirect(redirectUrl);
        return;
      } else {
        const cacheKey = path;
        const cachedImage = await imageCache.get(cacheKey);
        
        if (cachedImage) {
          logInfo(`[缓存] 命中 ${path} (${imageCache.formatSize(cachedImage.data.length)})`);
          ctx.response.headers.set("Content-Type", cachedImage.contentType);
          Object.entries(cacheHeaders).forEach(([k, v]) => ctx.response.headers.set(k, v));
          ctx.response.body = cachedImage.data;
          return;
        }
        
        logInfo(`[代理] 开始下载: ${targetUrl}`);
        const useProxy = proxyConfig.useProxy !== false && config.httpProxy?.enabled;
        
        try {
          const fetchOptions: any = {
            method: ctx.request.method,
            headers: {}
          };
          
          const response = await fetch(targetUrl.toString(), fetchOptions);
          
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          
          const contentType = response.headers.get("Content-Type") || "application/octet-stream";
          const buffer = new Uint8Array(await response.arrayBuffer());
          const ext = path.split('.').pop()?.toLowerCase() || '';
          
          if (config.cache?.enabled && imageCache.isCacheable(ext, buffer.length)) {
            logInfo(`[缓存] 存储 ${path} (${imageCache.formatSize(buffer.length)})`);
            await imageCache.set(cacheKey, buffer, contentType);
          }
          
          ctx.response.headers.set("Content-Type", contentType);
          Object.entries(cacheHeaders).forEach(([k, v]) => ctx.response.headers.set(k, v));
          ctx.response.body = buffer;
          
        } catch (error: unknown) {
          logError(`[错误] 下载失败: ${error instanceof Error ? error.message : String(error)}`);
          ctx.response.status = 500;
          ctx.response.body = 'Internal Server Error';
        }
      }
    } catch (error: unknown) {
      logError(`[错误] 代理请求失败: ${error instanceof Error ? error.message : String(error)}`);
      ctx.response.status = 500;
      ctx.response.body = 'Internal Server Error';
    }
  });

  app.use(async (ctx, next) => {
    const path = ctx.request.url.pathname;
    
    if (path === "/") {
      if (!homepage) {
        ctx.response.status = 503;
        ctx.response.body = "Service Unavailable";
        return;
      }
      ctx.response.headers.set("Content-Type", "text/html; charset=utf-8");
      Object.entries(cacheHeaders).forEach(([k, v]) => ctx.response.headers.set(k, v));
      ctx.response.body = homepage;
      return;
    }

    if (path === "/favicon.ico") {
      if (!favicon) {
        ctx.response.status = 404;
        ctx.response.body = "Not Found";
        return;
      }
      ctx.response.headers.set("Content-Type", "image/x-icon");
      Object.entries(cacheHeaders).forEach(([k, v]) => ctx.response.headers.set(k, v));
      ctx.response.body = favicon;
      return;
    }
    
    if (path.startsWith("/assets/")) {
      try {
        await send(ctx, path, {
          root: PUBLIC_DIR,
        });
        return;
      } catch (err) {
        await next();
      }
    }
    
    await next();
  });
  
  app.use(router.routes());
  app.use(router.allowedMethods());
  
  const PORT = config.port || 3000;
  const host = config.host || 'localhost';
  
  logInfo('================= MIFENG CDN代理服务 启动信息 =================');
  logInfo(`服务名称: ${config.title}`);
  logInfo(`服务描述: ${config.description}`);
  logInfo(`页脚信息: ${config.footer}`);
  logInfo(`监听地址: http://${host}:${PORT}`);
  logInfo(`缓存类型: ${imageCache.cacheConfig.type === 'disk' ? '硬盘缓存' : '内存缓存'}`);
  logInfo(`缓存启用: ${config.cache?.enabled !== false ? '是' : '否'}`);
  logInfo(`最小缓存大小: ${config.cache?.minSize || '5MB'}`);
  logInfo(`最大缓存大小: ${imageCache.cacheConfig.maxSize}`);
  logInfo(`缓存时间: ${Math.floor(maxAgeSeconds / 86400)}天`);
  logInfo(`支持图片类型: ${(config.cache?.imageTypes || []).join(', ')}`);
  logInfo(`全局代理: ${config.httpProxy?.enabled ? '启用' : '禁用'}`);
  if (config.httpProxy?.enabled) {
    const proxyAddress = config.httpProxy.address + (config.httpProxy.port ? `:${config.httpProxy.port}` : '');
    logInfo(`代理地址: ${proxyAddress}`);
    logInfo(`代理认证: ${config.httpProxy.username ? '已配置' : '未配置'}`);
  }
  logInfo('代理配置:');
  (config.proxies || []).forEach((proxy: any) => {
    logInfo(`  - 路径: ${proxy.prefix} 目标: ${proxy.target} 可见: ${proxy.visible !== false ? '是' : '否'} 使用代理: ${proxy.useProxy !== false ? '是' : '否'} 描述: ${proxy.description || '无'}`);
  });
  logInfo(`建站时间: ${formatEstablishTime(config.establishTime)}`);
  logInfo(`已运行: ${calculateUptime(config.establishTime)}`);
  logInfo('============================================================');
  
  return app.listen({ port: PORT });
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error('服务器启动失败:', error);
    Deno.exit(1);
  }
}

export { app };