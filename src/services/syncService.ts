import axios from 'axios';
import crypto from 'crypto';
import { Task, SyncQueueItem, SyncResult, BatchSyncRequest, BatchSyncResponse, SyncError } from '../types';
import { Database } from '../db/database';
import { TaskService } from './taskService';
import { v4 as uuidv4 } from 'uuid';
export class SyncService {
  private apiUrl: string;
  private readonly BATCH_SIZE = parseInt(process.env.SYNC_BATCH_SIZE || '10');
  private readonly MAX_RETRIES = 3;
  constructor(
    private db: Database,
    private taskService: TaskService,
    apiUrl: string = process.env.API_BASE_URL || 'http://localhost:3000/api'
  ) {
    this.apiUrl = apiUrl;
  }

  async sync(): Promise<SyncResult> {
    const result: SyncResult = {
      success: true,
      synced_items: 0,
      failed_items: 0,
      errors: []
    };

    try {
      // Check connectivity first
      const isConnected = await this.checkConnectivity();
      if (!isConnected) {
        result.success = false;
        result.errors.push({
          task_id: 'connection',
          operation: 'connectivity_check',
          error: 'Server is not reachable',
          timestamp: new Date()
        });
        return result;
      }

      // Get all items from sync queue ordered chronologically per task
      const queueItems = await this.getSyncQueueItems();

      if (queueItems.length === 0) {
        return result;
      }

      // Group items by task and maintain chronological order
      const itemsByTask = this.groupItemsByTaskChronologically(queueItems);

      // Process items in batches while maintaining chronological order per task
      const batches = this.createBatches(itemsByTask);

      for (const batch of batches) {
        try {
          const batchResponse = await this.processBatch(batch);

          for (const processedItem of batchResponse.processed_items) {
            const originalItem = batch.find(item => item.id === processedItem.client_id);

            if (!originalItem) continue;

            if (processedItem.status === 'success') {
              await this.updateSyncStatus(originalItem.task_id, 'synced', {
                server_id: processedItem.server_id
              });
              result.synced_items++;
            } else if (processedItem.status === 'conflict' && processedItem.resolved_data) {
              // Handle conflict resolution
              const resolvedTask = await this.resolveConflict(
                (originalItem.data) as Task,
                processedItem.resolved_data
              );
              await this.updateSyncStatus(originalItem.task_id, 'synced', resolvedTask);
              result.synced_items++;
            } else {
              // Handle error
              const error = new Error(processedItem.error || 'Unknown sync error');
              await this.handleSyncError(originalItem, error);
              result.failed_items++;
              result.errors.push({
                task_id: originalItem.task_id,
                operation: originalItem.operation,
                error: error.message,
                timestamp: new Date()
              });
            }
          }
        } catch (error) {
          // Handle batch processing error
          for (const item of batch) {
            await this.handleSyncError(item, error as Error);
            result.failed_items++;
            result.errors.push({
              task_id: item.task_id,
              operation: item.operation,
              error: (error as Error).message,
              timestamp: new Date()
            });
          }
        }
      }

      result.success = result.errors.length === 0;
      return result;

    } catch (error) {
      result.success = false;
      result.errors.push({
        task_id: 'sync_service',
        operation: 'sync',
        error: (error as Error).message,
        timestamp: new Date()
      });
      return result;
    }
  }

  async addToSyncQueue(taskId: string, operation: 'create' | 'update' | 'delete', data: Partial<Task>): Promise<void> {
    const queueId = uuidv4();
    const now = new Date().toISOString();

    const sql = `
      INSERT INTO sync_queue (id, task_id, operation, data, created_at, retry_count)
      VALUES (?, ?, ?, ?, ?, 0)
    `;

    await this.db.run(sql, [
      queueId,
      taskId,
      operation,
      JSON.stringify(data),
      now
    ]);
  }

  private async processBatch(items: SyncQueueItem[]): Promise<BatchSyncResponse> {
    for (const item of items) {
      await this.updateTaskSyncStatus(item.task_id, 'in-progress');
    }
   // Add checksum for batch integrity
   const checksum = this.calculateBatchChecksum(items);
    // Create batch request with checksum
    const batchRequest: BatchSyncRequest = {
      items,
      client_timestamp: new Date(),
      checksum
    };


    // Add checksum for batch integrity
    //const checksum = this.calculateBatchChecksum(items);

    try {
      const response = await axios.post(`${this.apiUrl}/sync/batch`, {
        ...batchRequest,
        checksum
      }, {
        timeout: 30000,
        headers: {
          'Content-Type': 'application/json'
        }
      });

      return response.data;
    } catch (error) {
      // Reset sync status for failed items
      for (const item of items) {
        await this.updateTaskSyncStatus(item.task_id, 'error');
      }
      throw error;
    }
  }

  private async resolveConflict(localTask: Task, serverTask: Task): Promise<Task> {
    const localTime = new Date(localTask.updated_at).getTime();
    const serverTime = new Date(serverTask.updated_at).getTime();

    let resolvedTask: Task;

    if (localTime > serverTime) {
      resolvedTask = localTask;
      console.log(`Conflict resolved: Local task wins (newer timestamp) for task ${localTask.id}`);
    } else if (serverTime > localTime) {
      resolvedTask = serverTask;
      console.log(`Conflict resolved: Server task wins (newer timestamp) for task ${localTask.id}`);
    } else {
      // Timestamps are equal, use operation priority from challenge constraints
      // Since we don't have operation info here, default to server wins
      resolvedTask = serverTask;
      console.log(`Conflict resolved: Server task wins (equal timestamps) for task ${localTask.id}`);
    }

    return resolvedTask;
  }

  private async updateSyncStatus(taskId: string, status: 'synced' | 'error', serverData?: Partial<Task>): Promise<void> {
    const now = new Date().toISOString();
    let sql = `
      UPDATE tasks 
      SET sync_status = ?, last_synced_at = ?
    `;
    let params = [status, now];

    if (serverData?.server_id) {
      sql += `, server_id = ?`;
      params.push(serverData.server_id);
    }

    sql += ` WHERE id = ?`;
    params.push(taskId);

    await this.db.run(sql, params);

    // Remove from sync queue if successful
    if (status === 'synced') {
      await this.db.run(`DELETE FROM sync_queue WHERE task_id = ?`, [taskId]);
    }
  }

  private async updateTaskSyncStatus(taskId: string, status: string): Promise<void> {
    await this.db.run(
      `UPDATE tasks SET sync_status = ? WHERE id = ?`,
      [status, taskId]
    );
  }

  private async handleSyncError(item: SyncQueueItem, error: Error): Promise<void> {
    const newRetryCount = item.retry_count + 1;

    if (newRetryCount >= this.MAX_RETRIES) {
      // Move to dead letter queue
      await this.moveToDeadLetterQueue(item, error.message);
      await this.updateTaskSyncStatus(item.task_id, 'failed');
      // Remove from sync queue
      await this.db.run(`DELETE FROM sync_queue WHERE id = ?`, [item.id]);
    } else {
      // Update retry count and error message
      await this.db.run(
        `UPDATE sync_queue SET retry_count = ?, error_message = ? WHERE id = ?`,
        [newRetryCount, error.message, item.id]
      );
      await this.updateTaskSyncStatus(item.task_id, 'error');
    }
  }

  private async moveToDeadLetterQueue(item: SyncQueueItem, errorMessage: string): Promise<void> {
    const now = new Date().toISOString();

    const sql = `
      INSERT INTO dead_letter_queue (
        id, task_id, operation, data, created_at, failed_at, 
        retry_count, final_error_message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await this.db.run(sql, [
      item.id,
      item.task_id,
      item.operation,
      item.data,
      item.created_at.toISOString(),
      now,
      item.retry_count,
      errorMessage
    ]);
  }

  async checkConnectivity(): Promise<boolean> {
    // TODO: Check if server is reachable
    // 1. Make a simple health check request
    // 2. Return true if successful, false otherwise
    try {
      await axios.get(`${this.apiUrl}/sync/health`, { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }
private async getSyncQueueItems(): Promise<SyncQueueItem[]> {
    const sql = `
      SELECT * FROM sync_queue 
      ORDER BY task_id, created_at ASC
    `;

    const rows = await this.db.all(sql);
    return rows.map(row => ({
      id: row.id,
      task_id: row.task_id,
      operation: row.operation,
      data: JSON.parse(row.data),
      created_at: new Date(row.created_at),
      retry_count: row.retry_count,
      error_message: row.error_message
    }));
  }

  private groupItemsByTaskChronologically(items: SyncQueueItem[]): Map<string, SyncQueueItem[]> {
    const groups = new Map<string, SyncQueueItem[]>();

    for (const item of items) {
      if (!groups.has(item.task_id)) {
        groups.set(item.task_id, []);
      }
      groups.get(item.task_id)!.push(item);
    }

    // Sort items within each group chronologically
    for (const [taskId, taskItems] of groups.entries()) {
      taskItems.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
    }

    return groups;
  }

  private createBatches(itemsByTask: Map<string, SyncQueueItem[]>): SyncQueueItem[][] {
    const batches: SyncQueueItem[][] = [];
    let currentBatch: SyncQueueItem[] = [];

    for (const [taskId, taskItems] of itemsByTask.entries()) {
      for (const item of taskItems) {
        if (currentBatch.length >= this.BATCH_SIZE) {
          batches.push(currentBatch);
          currentBatch = [];
        }
        currentBatch.push(item);
      }
    }

    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    return batches;
  }

  private calculateBatchChecksum(items: SyncQueueItem[]): string {
    const data = items.map(item => `${item.id}-${item.operation}-${item.task_id}`).join('|');
    return crypto.createHash('md5').update(data).digest('hex');
  }

  async getPendingSyncCount(): Promise<number> {
    const result = await this.db.get(`SELECT COUNT(*) as count FROM sync_queue`);
    return result.count;
  }

  async getLastSyncTimestamp(): Promise<Date | null> {
    const result = await this.db.get(`
      SELECT MAX(last_synced_at) as last_sync 
      FROM tasks 
      WHERE last_synced_at IS NOT NULL
    `);
    return result.last_sync ? new Date(result.last_sync) : null;
  }

  async getDeadLetterQueue(): Promise<any[]> {
    const sql = `SELECT * FROM dead_letter_queue ORDER BY failed_at DESC`;
    return await this.db.all(sql);
  }
}
