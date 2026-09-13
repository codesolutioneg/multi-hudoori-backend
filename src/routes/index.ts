import { Router } from 'express';
import authRoutes from './auth.routes';
import adminRoutes from './admin.routes';
import biotimeRoutes from './biotime.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/admin', adminRoutes);
router.use('/biotime', biotimeRoutes);

export default router;
