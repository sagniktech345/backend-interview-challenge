import { Router, Request, Response } from 'express';
import { SyncService } from '../services/syncService';
import { TaskService } from '../services/taskService';
import { Database } from '../db/database';


export function createSyncRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Trigger manual sync
  router.post('/sync', async (req: Request, res: Response) => {
     try {
      // Check connectivity first
      const isConnected = await syncService.checkConnectivity();
      if (!isConnected) {
        return res.status(503).json({ 
          error: 'Server is not reachable',
          sync_result: {
            success: false,
            synced_items: 0,
            failed_items: 0,
            errors: [{
              task_id: 'connection',
              operation: 'connectivity_check',
              error: 'Server is not reachable',
              timestamp: new Date()
            }]
          }
        });
      }

      // Call syncService.sync()
      const syncResult = await syncService.sync();

      // Return sync result
      const statusCode = syncResult.success ? 200 : 207; // 207 Multi-Status for partial success
      res.status(statusCode).json({
        message: syncResult.success ? 'Sync completed successfully' : 'Sync completed with errors',
        sync_result: syncResult,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error during sync:', error);
      res.status(500).json({ 
        error: 'Sync failed',
        details: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Check sync status
  router.get('/status', async (req: Request, res: Response) => {
    try {
      // Get pending sync count
      const pendingCount = await syncService.getPendingSyncCount();

      // Get last sync timestamp
      const lastSync = await syncService.getLastSyncTimestamp();

      // Check connectivity
      const isConnected = await syncService.checkConnectivity();

      // Get dead letter queue count
      const deadLetterQueue = await syncService.getDeadLetterQueue();

      // Return status summary
      res.json({
        connectivity: {
          online: isConnected,
          last_checked: new Date().toISOString()
        },
        sync_status: {
          pending_items: pendingCount,
          last_sync: lastSync?.toISOString() || null,
          failed_items: deadLetterQueue.length
        },
        dead_letter_queue: {
          count: deadLetterQueue.length,
          items: deadLetterQueue.slice(0, 10) // Return first 10 items for preview
        },
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error getting sync status:', error);
      res.status(500).json({ 
        error: 'Failed to get sync status',
        details: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Batch sync endpoint (for server-side)
  router.post('/batch', async (req: Request, res: Response) => {
    try {
      // This endpoint would typically be implemented on the actual server
      // For this client implementation, we'll return a mock response
      // that simulates server-side batch processing

      const { items, checksum, client_timestamp } = req.body;

      if (!items || !Array.isArray(items)) {
        return res.status(400).json({ error: 'Invalid batch request: items array required' });
      }

      if (!checksum) {
        return res.status(400).json({ error: 'Invalid batch request: checksum required' });
      }

      // Mock server response for testing purposes
      const processed_items = items.map((item: any) => ({
        client_id: item.id,
        server_id: `server_${item.id}`,
        status: 'success' as const,
        resolved_data: undefined,
        error: undefined
      }));

      const response = {
        processed_items,
        server_timestamp: new Date(),
        checksum_verified: true
      };

      res.json(response);

    } catch (error) {
      console.error('Error processing batch sync:', error);
      res.status(500).json({ 
        error: 'Batch sync processing failed',
        details: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Dead letter queue endpoint
  router.get('/dead-letter-queue', async (req: Request, res: Response) => {
    try {
      const deadLetterQueue = await syncService.getDeadLetterQueue();

      res.json({
        count: deadLetterQueue.length,
        items: deadLetterQueue,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      console.error('Error getting dead letter queue:', error);
      res.status(500).json({ 
        error: 'Failed to get dead letter queue',
        details: (error as Error).message,
        timestamp: new Date().toISOString()
      });
    }
  });

  // Health check endpoint
  router.get('/health', async (req: Request, res: Response) => {
    res.json({ 
      status: 'ok', 
      timestamp: new Date(),
      service: 'task-sync-api',
      version: '1.0.0'
    });
  });

  return router;
}