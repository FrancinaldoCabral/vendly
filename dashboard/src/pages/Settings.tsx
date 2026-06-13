import { useEffect } from 'react';
import { Typography, Card, Form, Input, Button, Tag, message, Descriptions } from 'antd';
import { SettingOutlined, SaveOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import dayjs from 'dayjs';

const { Title, Paragraph } = Typography;

export default function Settings() {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.getMe });

  useEffect(() => {
    if (me) form.setFieldsValue({ name: me.name });
  }, [me, form]);

  const save = useMutation({
    mutationFn: (vals: { name: string }) => api.updateMe({ name: vals.name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['me'] }); message.success('Configurações salvas!'); },
    onError: (e: Error) => message.error(e.message),
  });

  const planColor: Record<string, string> = { pro: 'gold', starter: 'blue', free: 'default' };

  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}><SettingOutlined /> Configurações</Title>
      <Paragraph type="secondary">
        Informações da sua conta Vendly e do plano contratado.
        Para suporte, entre em contato em <a href="mailto:suporte@vendly.chat">suporte@vendly.chat</a>.
      </Paragraph>

      <Card title="Minha conta" style={{ marginBottom: 16 }}>
        <Descriptions column={1} style={{ marginBottom: 16 }}>
          <Descriptions.Item label="Email">{me?.email ?? '—'}</Descriptions.Item>
          <Descriptions.Item label="Plano">
            <Tag color={planColor[me?.plan ?? ''] ?? 'default'} style={{ textTransform: 'uppercase' }}>
              {me?.plan ?? 'free'}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Status">
            <Tag color={me?.status === 'active' ? 'success' : 'error'}>
              {me?.status === 'active' ? 'Ativo' : 'Suspenso'}
            </Tag>
          </Descriptions.Item>
          {me?.createdAt && (
            <Descriptions.Item label="Membro desde">
              {dayjs(me.createdAt).format('DD/MM/YYYY')}
            </Descriptions.Item>
          )}
        </Descriptions>

        <Form form={form} layout="vertical" onFinish={vals => save.mutate(vals)}>
          <Form.Item name="name" label="Nome da empresa / identificador" rules={[{ required: true }]}>
            <Input placeholder="Minha Empresa" style={{ maxWidth: 360 }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" icon={<SaveOutlined />} loading={save.isPending}>
            Salvar
          </Button>
        </Form>
      </Card>

      <Card title="Identificador da conta" size="small">
        <Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 13 }}>
          Este é o ID da sua conta. Use-o para comunicação com o suporte.
        </Paragraph>
        <Input value={me?._id ?? ''} readOnly style={{ fontFamily: 'monospace', fontSize: 13, maxWidth: 360 }} />
      </Card>
    </div>
  );
}
