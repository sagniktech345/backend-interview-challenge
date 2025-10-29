import { Router, Request, Response } from 'express';
import { TaskService } from '../services/taskService';
import { SyncService } from '../services/syncService';
import { Database } from '../db/database';


export function createTaskRouter(db: Database): Router {
  const router = Router();
  const taskService = new TaskService(db);
  const syncService = new SyncService(db, taskService);

  // Get all tasks
  router.get('/', async (req: Request, res: Response) => {
    try {
      const tasks = await taskService.getAllTasks();
      res.json(tasks);
    } catch (error) {
      console.error('Error fetching tasks:', error);
      res.status(500).json({ error: 'Failed to fetch tasks' });
    }
  });

  // Get single task
  router.get('/:id', async (req: Request, res: Response) => {
    try {
      const task = await taskService.getTask(req.params.id);
      if (!task) {
        return res.status(404).json({ error: 'Task not found' });
      }
      res.json(task);
    } catch (error) {
      console.error('Error fetching tasks:', error);
      res.status(500).json({ error: 'Failed to fetch task' });
    }
  });

  // Create task
  router.post('/', async (req: Request, res: Response) => {
    try {
      // Validate request body
      const { title, description, completed } = req.body;

      if (!title || title.trim().length === 0) {
        return res.status(400).json({ error: 'Title is required' });
      }

      // Create task data object
      const taskData = {
        title: title.trim(),
        description: description?.trim() || undefined,
        completed: Boolean(completed)
      };

      // Call taskService.createTask()
      const createdTask = await taskService.createTask(taskData);

      // Return created task
      res.status(201).json(createdTask);
    } catch (error) {
      console.error('Error creating task:', error);
      res.status(500).json({ error: 'Failed to create task' });
    }
  });

  // Update task
  router.put('/:id', async (req: Request, res: Response) => {
    try {
      const taskId = req.params.id;

      // Validate request body
      const { title, description, completed } = req.body;

      if (title !== undefined && (!title || title.trim().length === 0)) {
        return res.status(400).json({ error: 'Title cannot be empty' });
      }

      // Prepare update data
      const updates: any = {};
      if (title !== undefined) updates.title = title.trim();
      if (description !== undefined) updates.description = description?.trim() || null;
      if (completed !== undefined) updates.completed = Boolean(completed);

      // Call taskService.updateTask()
      const updatedTask = await taskService.updateTask(taskId, updates);

      // Handle not found case
      if (!updatedTask) {
        return res.status(404).json({ error: 'Task not found' });
      }

      // Return updated task
      res.json(updatedTask);
    } catch (error) {
      console.error('Error updating task:', error);
      res.status(500).json({ error: 'Failed to update task' });
    }
  });

  // Delete task
  router.delete('/:id', async (req: Request, res: Response) => {
    try {
      const taskId = req.params.id;

      // Call taskService.deleteTask()
      const deleted = await taskService.deleteTask(taskId);

      // Handle not found case
      if (!deleted) {
        return res.status(404).json({ error: 'Task not found' });
      }

      // Return success response
      res.json({ 
        message: 'Task deleted successfully',
        id: taskId,
        timestamp: new Date().toISOString()
      });
    } catch (error) {
      console.error('Error deleting task:', error);
      res.status(500).json({ error: 'Failed to delete task' });
    }
  });

  return router;
}