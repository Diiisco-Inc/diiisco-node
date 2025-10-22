enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  SILENT = 4,
}

class Logger {
  private level: LogLevel;

  constructor(level: LogLevel = LogLevel.INFO) {
    this.level = level;
  }

  private log(level: LogLevel, message: string, ...args: any[]) {
    if (level >= this.level) {
      const timestamp = new Date().toISOString();
      const levelStr = LogLevel[level];
      switch (level) {
        case LogLevel.DEBUG:
          console.debug(`[${timestamp}] [DEBUG] ${message}`, ...args);
          break;
        case LogLevel.INFO:
          console.info(`[${timestamp}] [INFO] ${message}`, ...args);
          break;
        case LogLevel.WARN:
          console.warn(`[${timestamp}] [WARN] ${message}`, ...args);
          break;
        case LogLevel.ERROR:
          console.error(`[${timestamp}] [ERROR] ${message}`, ...args);
          break;
        default:
          console.log(`[${timestamp}] [${levelStr}] ${message}`, ...args);
      }
    }
  }

  debug(message: string, ...args: any[]) {
    this.log(LogLevel.DEBUG, message, ...args);
  }

  info(message: string, ...args: any[]) {
    this.log(LogLevel.INFO, message, ...args);
  }

  warn(message: string, ...args: any[]) {
    this.log(LogLevel.WARN, message, ...args);
  }

  error(message: string, ...args: any[]) {
    this.log(LogLevel.ERROR, message, ...args);
  }
}

export const logger = new Logger(LogLevel.INFO); // Default log level to INFO