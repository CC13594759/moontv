/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion */
/**
 * 文件存储后端：把原来存在 kvrocks/redis 里的全部数据存进 moontv 容器内
 * 的一个 JSON 文件，取消对外部存储服务的依赖。
 *
 * 数据文件位置（运行时环境变量，可不改）：
 *   FILE_DB_PATH，默认 <工作目录>/data/moontv-data.json
 *   Docker 部署时必须把该文件所在目录挂卷到宿主机（见 Dockerfile 的
 *   /app/data），否则容器删除重建后数据会丢。
 *
 * 文件格式（单文件、整文件读写 + 临时文件重命名，保证写一半崩溃不损坏
 * 旧文件；局域网个人使用量级下整文件读写足够，见 db.ts 的 IStorage）：
 *   {
 *     version: 1,
 *     adminConfig: AdminConfig | null,
 *     users: { [username]: { password: string } },
 *     playRecords: { [username]: { [source+id]: PlayRecord } },
 *     favorites: { [username]: { [source+id]: Favorite } },
 *     searchHistory: { [username]: string[] },
 *     skipConfigs: { [username]: { [source+id]: SkipConfig } }
 *   }
 *
 * 注意：用户密码与上游 kvrocks/redis 后端一样是明文存放（见
 * redis-base.db.ts 的 registerUser 注释），本后端不改变这一口径，
 * 仅限局域网使用，切勿对外暴露。
 */

import { promises as fs } from 'fs';
import path from 'path';

import { AdminConfig } from './admin.types';
import { Favorite, IStorage, PlayRecord, SkipConfig } from './types';

const SEARCH_HISTORY_LIMIT = 20;

interface FileStore {
  version: number;
  adminConfig: AdminConfig | null;
  users: Record<string, { password: string }>;
  playRecords: Record<string, Record<string, PlayRecord>>;
  favorites: Record<string, Record<string, Favorite>>;
  searchHistory: Record<string, string[]>;
  skipConfigs: Record<string, Record<string, SkipConfig>>;
}

function emptyStore(): FileStore {
  return {
    version: 1,
    adminConfig: null,
    users: {},
    playRecords: {},
    favorites: {},
    searchHistory: {},
    skipConfigs: {},
  };
}

function normalizeStore(raw: any): FileStore {
  const base = emptyStore();
  if (!raw || typeof raw !== 'object') {
    return base;
  }
  return {
    version: 1,
    adminConfig: raw.adminConfig ?? null,
    users: raw.users ?? {},
    playRecords: raw.playRecords ?? {},
    favorites: raw.favorites ?? {},
    searchHistory: raw.searchHistory ?? {},
    skipConfigs: raw.skipConfigs ?? {},
  };
}

export class FileStorage implements IStorage {
  private filePath: string;
  // 串行化所有读写：避免两次“读-改-写”交错导致后一次覆盖前一次。
  private queue: Promise<void> = Promise.resolve();

  constructor(filePath?: string) {
    this.filePath =
      filePath ||
      process.env.FILE_DB_PATH ||
      path.join(process.cwd(), 'data', 'moontv-data.json');
  }

  private async run<T>(fn: () => Promise<T>): Promise<T> {
    const task = this.queue.then(fn, fn);
    // 队列本身永不中断：出错也继续接受下一个任务。
    this.queue = task.then(
      () => undefined,
      () => undefined
    );
    return task;
  }

  private async load(): Promise<FileStore> {
    try {
      const text = await fs.readFile(this.filePath, 'utf-8');
      return normalizeStore(JSON.parse(text));
    } catch (err: any) {
      if (err?.code === 'ENOENT') {
        return emptyStore();
      }
      // 文件存在但解析失败：把损坏文件改名留证，从空库启动，
      // 避免启动即崩、也避免直接覆盖损坏文件导致无法事后检查。
      console.error('文件存储解析失败，已把损坏文件改名并从空库启动:', err);
      try {
        const backup = `${this.filePath}.corrupt-${Date.now()}`;
        await fs.rename(this.filePath, backup);
        console.error('损坏文件已备份为:', backup);
      } catch (backupErr) {
        console.error('备份损坏文件失败:', backupErr);
      }
      return emptyStore();
    }
  }

  private async save(store: FileStore): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp-${process.pid}`;
    await fs.writeFile(tmpPath, JSON.stringify(store), 'utf-8');
    await fs.rename(tmpPath, this.filePath);
  }

  private async mutate<T>(fn: (store: FileStore) => T | Promise<T>): Promise<T> {
    return this.run(async () => {
      const store = await this.load();
      const result = await fn(store);
      await this.save(store);
      return result;
    });
  }

  private async read<T>(fn: (store: FileStore) => T | Promise<T>): Promise<T> {
    return this.run(async () => fn(await this.load()));
  }

  // ---------- 播放记录 ----------
  async getPlayRecord(
    userName: string,
    key: string
  ): Promise<PlayRecord | null> {
    return this.read((store) => store.playRecords[userName]?.[key] ?? null);
  }

  async setPlayRecord(
    userName: string,
    key: string,
    record: PlayRecord
  ): Promise<void> {
    await this.mutate((store) => {
      if (!store.playRecords[userName]) {
        store.playRecords[userName] = {};
      }
      store.playRecords[userName][key] = record;
    });
  }

  async getAllPlayRecords(
    userName: string
  ): Promise<Record<string, PlayRecord>> {
    return this.read((store) => ({ ...(store.playRecords[userName] ?? {}) }));
  }

  async deletePlayRecord(userName: string, key: string): Promise<void> {
    await this.mutate((store) => {
      if (store.playRecords[userName]) {
        delete store.playRecords[userName][key];
      }
    });
  }

  // ---------- 收藏 ----------
  async getFavorite(
    userName: string,
    key: string
  ): Promise<Favorite | null> {
    return this.read((store) => store.favorites[userName]?.[key] ?? null);
  }

  async setFavorite(
    userName: string,
    key: string,
    favorite: Favorite
  ): Promise<void> {
    await this.mutate((store) => {
      if (!store.favorites[userName]) {
        store.favorites[userName] = {};
      }
      store.favorites[userName][key] = favorite;
    });
  }

  async getAllFavorites(
    userName: string
  ): Promise<Record<string, Favorite>> {
    return this.read((store) => ({ ...(store.favorites[userName] ?? {}) }));
  }

  async deleteFavorite(userName: string, key: string): Promise<void> {
    await this.mutate((store) => {
      if (store.favorites[userName]) {
        delete store.favorites[userName][key];
      }
    });
  }

  // ---------- 用户 ----------
  async registerUser(userName: string, password: string): Promise<void> {
    await this.mutate((store) => {
      store.users[userName] = { password };
    });
  }

  async verifyUser(userName: string, password: string): Promise<boolean> {
    return this.read(
      (store) => store.users[userName]?.password === password
    );
  }

  async checkUserExist(userName: string): Promise<boolean> {
    return this.read((store) => userName in store.users);
  }

  // 供数据迁移导出使用：IStorage 本身没有取密码的方法，上游导出是
  // 直接读 redis 的 storage.client，文件后端没有 client 会返回空，
  // 导致非站长用户密码在导出时丢失。本方法补上这一口径。
  async getUserPassword(userName: string): Promise<string | null> {
    return this.read((store) => store.users[userName]?.password ?? null);
  }

  async changePassword(userName: string, newPassword: string): Promise<void> {
    await this.mutate((store) => {
      if (store.users[userName]) {
        store.users[userName].password = newPassword;
      } else {
        store.users[userName] = { password: newPassword };
      }
    });
  }

  async deleteUser(userName: string): Promise<void> {
    await this.mutate((store) => {
      delete store.users[userName];
      delete store.searchHistory[userName];
      delete store.playRecords[userName];
      delete store.favorites[userName];
      delete store.skipConfigs[userName];
    });
  }

  // ---------- 搜索历史 ----------
  async getSearchHistory(userName: string): Promise<string[]> {
    return this.read((store) => [...(store.searchHistory[userName] ?? [])]);
  }

  async addSearchHistory(userName: string, keyword: string): Promise<void> {
    await this.mutate((store) => {
      const list = (store.searchHistory[userName] ?? []).filter(
        (k) => String(k) !== String(keyword)
      );
      list.unshift(String(keyword));
      store.searchHistory[userName] = list.slice(0, SEARCH_HISTORY_LIMIT);
    });
  }

  async deleteSearchHistory(userName: string, keyword?: string): Promise<void> {
    await this.mutate((store) => {
      if (keyword) {
        store.searchHistory[userName] = (store.searchHistory[userName] ?? []).filter(
          (k) => String(k) !== String(keyword)
        );
      } else {
        delete store.searchHistory[userName];
      }
    });
  }

  // ---------- 用户列表 ----------
  async getAllUsers(): Promise<string[]> {
    return this.read((store) => Object.keys(store.users));
  }

  // ---------- 管理员配置 ----------
  async getAdminConfig(): Promise<AdminConfig | null> {
    return this.read((store) => store.adminConfig);
  }

  async setAdminConfig(config: AdminConfig): Promise<void> {
    await this.mutate((store) => {
      store.adminConfig = config;
    });
  }

  // ---------- 跳过片头片尾配置 ----------
  async getSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<SkipConfig | null> {
    const key = `${source}+${id}`;
    return this.read((store) => store.skipConfigs[userName]?.[key] ?? null);
  }

  async setSkipConfig(
    userName: string,
    source: string,
    id: string,
    config: SkipConfig
  ): Promise<void> {
    const key = `${source}+${id}`;
    await this.mutate((store) => {
      if (!store.skipConfigs[userName]) {
        store.skipConfigs[userName] = {};
      }
      store.skipConfigs[userName][key] = config;
    });
  }

  async deleteSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<void> {
    const key = `${source}+${id}`;
    await this.mutate((store) => {
      if (store.skipConfigs[userName]) {
        delete store.skipConfigs[userName][key];
      }
    });
  }

  async getAllSkipConfigs(
    userName: string
  ): Promise<{ [key: string]: SkipConfig }> {
    return this.read((store) => ({ ...(store.skipConfigs[userName] ?? {}) }));
  }

  // ---------- 清空所有数据 ----------
  // 等价于上游“删全部用户 + 删管理员配置”：直接把空库写回文件。
  async clearAllData(): Promise<void> {
    await this.run(async () => {
      await this.save(emptyStore());
    });
  }
}
