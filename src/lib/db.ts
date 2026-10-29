/* eslint-disable no-console, @typescript-eslint/no-explicit-any, @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-empty-function */

import { AdminConfig } from './admin.types';
import { Favorite, IStorage, PlayRecord, SkipConfig } from './types';

// storage type 常量: 'localstorage' | 'redis' | 'upstash' | 'kvrocks' | 'file'，默认 'localstorage'
// 'file' 为本项目新增的文件存储：数据存 moontv 容器内的 JSON 文件，
// 不再依赖 kvrocks/redis/upstash 等外部存储服务。
const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'upstash'
    | 'kvrocks'
    | 'file'
    | undefined) || 'localstorage';

// 存储后端加载方式（实测修正）：
// 原来 db.ts 静态 import 了全部后端，Next standalone 会把
// redis/upstash 一并打进镜像。先试过按需动态 import，但实测发现
// Next 只是把 redis/upstash 打进懒加载 chunk，仍在 standalone 里，
// 镜像一点没小（redis 相关 chunk 约 0.4 MB 仍在）。所以本文件版
// 干脆不再 import 其他后端：只保留 file 与 localstorage（空后端），
// redis/upstash/kvrocks 的源码文件仍在仓库里、只是不被引用，
// 将来要恢复时把下面对应的分支加回来即可。
class LazyStorage implements IStorage {
  private real: IStorage | null = null;
  private loading: Promise<IStorage> | null = null;

  private async ensure(): Promise<IStorage> {
    if (this.real) {
      return this.real;
    }
    if (!this.loading) {
      this.loading = (async () => {
        switch (STORAGE_TYPE) {
          case 'file': {
            const { FileStorage } = await import('./file.db.js');
            return new FileStorage();
          }
          case 'redis':
          case 'upstash':
          case 'kvrocks':
            // 文件版已砍掉其他后端：见文件头注释，动态 import 测过
            // 仍会被打进 standalone，达不到省镜像的效果，故直接报错，
            // 避免静默回落到空后端导致数据“丢了”的假象。
            throw new Error(
              `存储类型 ${STORAGE_TYPE} 在文件版中已被移除，请用 file`
            );
          case 'localstorage':
          default:
            return new NullStorage();
        }
      })();
    }
    this.real = await this.loading;
    return this.real;
  }

  // 数据迁移导出用：优先用后端自带的取密码方法（文件后端），
  // 其次用 redis 系后端的 client.get（上游原有口径），都没有则返回空。
  async getUserPassword(userName: string): Promise<string | null> {
    const real: any = await this.ensure();
    if (typeof real.getUserPassword === 'function') {
      return real.getUserPassword(userName);
    }
    if (typeof real.client?.get === 'function') {
      return real.client.get(`u:${userName}:pwd`);
    }
    return null;
  }

  async getPlayRecord(userName: string, key: string) {
    return (await this.ensure()).getPlayRecord(userName, key);
  }
  async setPlayRecord(userName: string, key: string, record: PlayRecord) {
    await (await this.ensure()).setPlayRecord(userName, key, record);
  }
  async getAllPlayRecords(userName: string) {
    return (await this.ensure()).getAllPlayRecords(userName);
  }
  async deletePlayRecord(userName: string, key: string) {
    await (await this.ensure()).deletePlayRecord(userName, key);
  }
  async getFavorite(userName: string, key: string) {
    return (await this.ensure()).getFavorite(userName, key);
  }
  async setFavorite(userName: string, key: string, favorite: Favorite) {
    await (await this.ensure()).setFavorite(userName, key, favorite);
  }
  async getAllFavorites(userName: string) {
    return (await this.ensure()).getAllFavorites(userName);
  }
  async deleteFavorite(userName: string, key: string) {
    await (await this.ensure()).deleteFavorite(userName, key);
  }
  async registerUser(userName: string, password: string) {
    await (await this.ensure()).registerUser(userName, password);
  }
  async verifyUser(userName: string, password: string) {
    return (await this.ensure()).verifyUser(userName, password);
  }
  async checkUserExist(userName: string) {
    return (await this.ensure()).checkUserExist(userName);
  }
  async changePassword(userName: string, newPassword: string) {
    await (await this.ensure()).changePassword(userName, newPassword);
  }
  async deleteUser(userName: string) {
    await (await this.ensure()).deleteUser(userName);
  }
  async getSearchHistory(userName: string) {
    return (await this.ensure()).getSearchHistory(userName);
  }
  async addSearchHistory(userName: string, keyword: string) {
    await (await this.ensure()).addSearchHistory(userName, keyword);
  }
  async deleteSearchHistory(userName: string, keyword?: string) {
    await (await this.ensure()).deleteSearchHistory(userName, keyword);
  }
  async getAllUsers() {
    return (await this.ensure()).getAllUsers();
  }
  async getAdminConfig() {
    return (await this.ensure()).getAdminConfig();
  }
  async setAdminConfig(config: AdminConfig) {
    await (await this.ensure()).setAdminConfig(config);
  }
  async getSkipConfig(userName: string, source: string, id: string) {
    return (await this.ensure()).getSkipConfig(userName, source, id);
  }
  async setSkipConfig(userName: string, source: string, id: string, config: SkipConfig) {
    await (await this.ensure()).setSkipConfig(userName, source, id, config);
  }
  async deleteSkipConfig(userName: string, source: string, id: string) {
    await (await this.ensure()).deleteSkipConfig(userName, source, id);
  }
  async getAllSkipConfigs(userName: string) {
    return (await this.ensure()).getAllSkipConfigs(userName);
  }
  async clearAllData() {
    await (await this.ensure()).clearAllData();
  }
}

// localstorage 模式的空后端：原来 DbManager 的 storage 是 null，
// 调用方用 typeof 检查来兜底；空后端把这些调用变成安全的空操作，
// 避免 null.storage 访问抛错，语义与原来“无服务端存储”一致。
class NullStorage implements IStorage {
  async getPlayRecord() {
    return null;
  }
  async setPlayRecord() {}
  async getAllPlayRecords() {
    return {};
  }
  async deletePlayRecord() {}
  async getFavorite() {
    return null;
  }
  async setFavorite() {}
  async getAllFavorites() {
    return {};
  }
  async deleteFavorite() {}
  async registerUser() {}
  async verifyUser() {
    return false;
  }
  async checkUserExist() {
    return false;
  }
  async changePassword() {}
  async deleteUser() {}
  async getSearchHistory() {
    return [];
  }
  async addSearchHistory() {}
  async deleteSearchHistory() {}
  async getAllUsers() {
    return [];
  }
  async getAdminConfig() {
    return null;
  }
  async setAdminConfig() {}
  async getSkipConfig() {
    return null;
  }
  async setSkipConfig() {}
  async deleteSkipConfig() {}
  async getAllSkipConfigs() {
    return {};
  }
  async clearAllData() {}
}

// 工具函数：生成存储key
export function generateStorageKey(source: string, id: string): string {
  return `${source}+${id}`;
}

// 导出便捷方法
export class DbManager {
  private storage: IStorage;

  constructor() {
    this.storage = new LazyStorage();
  }

  // 数据迁移导出用：取用户密码（文件后端自带、redis 系走 client）。
  async getUserPassword(userName: string): Promise<string | null> {
    const storage: any = this.storage;
    if (typeof storage.getUserPassword === 'function') {
      return storage.getUserPassword(userName);
    }
    return null;
  }

  // 播放记录相关方法
  async getPlayRecord(
    userName: string,
    source: string,
    id: string
  ): Promise<PlayRecord | null> {
    const key = generateStorageKey(source, id);
    return this.storage.getPlayRecord(userName, key);
  }

  async savePlayRecord(
    userName: string,
    source: string,
    id: string,
    record: PlayRecord
  ): Promise<void> {
    const key = generateStorageKey(source, id);
    await this.storage.setPlayRecord(userName, key, record);
  }

  async getAllPlayRecords(userName: string): Promise<{
    [key: string]: PlayRecord;
  }> {
    return this.storage.getAllPlayRecords(userName);
  }

  async deletePlayRecord(
    userName: string,
    source: string,
    id: string
  ): Promise<void> {
    const key = generateStorageKey(source, id);
    await this.storage.deletePlayRecord(userName, key);
  }

  // 收藏相关方法
  async getFavorite(
    userName: string,
    source: string,
    id: string
  ): Promise<Favorite | null> {
    const key = generateStorageKey(source, id);
    return this.storage.getFavorite(userName, key);
  }

  async saveFavorite(
    userName: string,
    source: string,
    id: string,
    favorite: Favorite
  ): Promise<void> {
    const key = generateStorageKey(source, id);
    await this.storage.setFavorite(userName, key, favorite);
  }

  async getAllFavorites(
    userName: string
  ): Promise<{ [key: string]: Favorite }> {
    return this.storage.getAllFavorites(userName);
  }

  async deleteFavorite(
    userName: string,
    source: string,
    id: string
  ): Promise<void> {
    const key = generateStorageKey(source, id);
    await this.storage.deleteFavorite(userName, key);
  }

  async isFavorited(
    userName: string,
    source: string,
    id: string
  ): Promise<boolean> {
    const favorite = await this.getFavorite(userName, source, id);
    return favorite !== null;
  }

  // ---------- 用户相关 ----------
  async registerUser(userName: string, password: string): Promise<void> {
    await this.storage.registerUser(userName, password);
  }

  async verifyUser(userName: string, password: string): Promise<boolean> {
    return this.storage.verifyUser(userName, password);
  }

  // 检查用户是否已存在
  async checkUserExist(userName: string): Promise<boolean> {
    return this.storage.checkUserExist(userName);
  }

  async changePassword(userName: string, newPassword: string): Promise<void> {
    await this.storage.changePassword(userName, newPassword);
  }

  async deleteUser(userName: string): Promise<void> {
    await this.storage.deleteUser(userName);
  }

  // ---------- 搜索历史 ----------
  async getSearchHistory(userName: string): Promise<string[]> {
    return this.storage.getSearchHistory(userName);
  }

  async addSearchHistory(userName: string, keyword: string): Promise<void> {
    await this.storage.addSearchHistory(userName, keyword);
  }

  async deleteSearchHistory(userName: string, keyword?: string): Promise<void> {
    await this.storage.deleteSearchHistory(userName, keyword);
  }

  // 获取全部用户名
  async getAllUsers(): Promise<string[]> {
    if (typeof (this.storage as any).getAllUsers === 'function') {
      return (this.storage as any).getAllUsers();
    }
    return [];
  }

  // ---------- 管理员配置 ----------
  async getAdminConfig(): Promise<AdminConfig | null> {
    if (typeof (this.storage as any).getAdminConfig === 'function') {
      return (this.storage as any).getAdminConfig();
    }
    return null;
  }

  async saveAdminConfig(config: AdminConfig): Promise<void> {
    if (typeof (this.storage as any).setAdminConfig === 'function') {
      await (this.storage as any).setAdminConfig(config);
    }
  }

  // ---------- 跳过片头片尾配置 ----------
  async getSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<SkipConfig | null> {
    if (typeof (this.storage as any).getSkipConfig === 'function') {
      return (this.storage as any).getSkipConfig(userName, source, id);
    }
    return null;
  }

  async setSkipConfig(
    userName: string,
    source: string,
    id: string,
    config: SkipConfig
  ): Promise<void> {
    if (typeof (this.storage as any).setSkipConfig === 'function') {
      await (this.storage as any).setSkipConfig(userName, source, id, config);
    }
  }

  async deleteSkipConfig(
    userName: string,
    source: string,
    id: string
  ): Promise<void> {
    if (typeof (this.storage as any).deleteSkipConfig === 'function') {
      await (this.storage as any).deleteSkipConfig(userName, source, id);
    }
  }

  async getAllSkipConfigs(
    userName: string
  ): Promise<{ [key: string]: SkipConfig }> {
    if (typeof (this.storage as any).getAllSkipConfigs === 'function') {
      return (this.storage as any).getAllSkipConfigs(userName);
    }
    return {};
  }

  // ---------- 数据清理 ----------
  async clearAllData(): Promise<void> {
    if (typeof (this.storage as any).clearAllData === 'function') {
      await (this.storage as any).clearAllData();
    } else {
      throw new Error('存储类型不支持清空数据操作');
    }
  }
}

// 导出默认实例
export const db = new DbManager();
