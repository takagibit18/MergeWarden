import type { ReviewStatus } from '@mergewarden/contracts';

export const statusLabels: Record<ReviewStatus, string> = {
  accepted: '已受理', running: '记录为运行中', completed: '已完成', partial: '部分完成', failed: '审查失败',
  cancelled: '已取消', no_changes: '无变更', delivery_failed: '交付失败', interrupted: '已中断',
};
