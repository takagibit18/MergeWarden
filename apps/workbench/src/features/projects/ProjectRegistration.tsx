import { useMutation, useQueryClient } from '@tanstack/react-query';
import Alert from 'antd/es/alert';
import Form from 'antd/es/form';
import Input from 'antd/es/input';
import Modal from 'antd/es/modal';
import type { ProjectDto } from '@mergewarden/contracts';
import { ApiError, describeError } from '../../shared/api/client';
import { registerProject, registerWorkspace } from '../../shared/api/reviews';

interface RegistrationValues { repositoryPath: string; name?: string }

export function ProjectRegistration({ project, onClose, onRegistered }: { project: ProjectDto | undefined; onClose: () => void; onRegistered: (project: ProjectDto) => void }) {
  const [form] = Form.useForm<RegistrationValues>();
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationKey: ['register-project', project?.id],
    mutationFn: (values: RegistrationValues) => {
      const name = values.name?.trim();
      const input = { repositoryPath: values.repositoryPath.trim(), ...(name ? { name } : {}) };
      return project ? registerWorkspace(project.id, input) : registerProject(input);
    },
    onSuccess: async registered => {
      await queryClient.invalidateQueries({ queryKey: ['projects'] });
      await queryClient.invalidateQueries({ queryKey: ['project', registered.id, 'history'] });
      onRegistered(registered);
    },
    onError: error => {
      if (error instanceof ApiError && error.fieldErrors) {
        form.setFields(Object.entries(error.fieldErrors).filter(([name]) => name === 'repositoryPath' || name === 'name').map(([name, errors]) => ({ name: [name as keyof RegistrationValues], errors })));
      }
    },
  });

  return (
    <Modal open title={project ? '登记工作树' : '添加项目'} okText={project ? '登记工作树' : '添加项目'} cancelText="取消" confirmLoading={mutation.isPending} onOk={() => form.submit()} {...(mutation.isPending ? {} : { onCancel: onClose })} closable={!mutation.isPending} maskClosable={!mutation.isPending} destroyOnHidden>
      <p className="registration-description">{project ? `将同一 Git 仓库的工作树加入「${project.name}」，审查历史将按项目汇总。` : '填写本机 Git 仓库的根目录。项目拥有独立的审查历史，可继续登记同仓工作树。'}</p>
      {mutation.isError ? <Alert className="registration-error" type="error" showIcon message="登记未完成" description={describeError(mutation.error)} /> : null}
      <Form form={form} layout="vertical" onFinish={values => mutation.mutate(values)} onValuesChange={() => mutation.reset()} requiredMark={false} disabled={mutation.isPending}>
        <Form.Item name="repositoryPath" label={project ? '工作树目录' : '仓库目录'} rules={[{ required: true, whitespace: true, message: '请输入本机 Git 根目录的绝对路径。' }, { validator: (_, value: unknown) => typeof value !== 'string' || !value.trim() || value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value.trim()) || value.trim().startsWith('\\\\') ? Promise.resolve() : Promise.reject(new Error('请输入绝对路径，例如 E:\\projects\\repo。')) }]}>
          <Input autoFocus placeholder="E:\projects\repository" autoComplete="off" maxLength={4096} />
        </Form.Item>
        <Form.Item name="name" label="显示名称（选填）" rules={[{ max: 80, message: '名称不能超过 80 个字符。' }]}><Input placeholder="默认使用目录名称" autoComplete="off" maxLength={80} /></Form.Item>
      </Form>
    </Modal>
  );
}
