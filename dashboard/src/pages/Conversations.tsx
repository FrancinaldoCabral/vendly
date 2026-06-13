import { useState } from 'react';
import { Typography, Table, Select, Input, Space, Button, Popconfirm, Tag, message, Modal } from 'antd';
import { MessageOutlined, DeleteOutlined, EyeOutlined, ReloadOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { Conversation } from '../lib/types';
import dayjs from 'dayjs';

const { Title, Text, Paragraph } = Typography;

export default function Conversations() {
  const qc = useQueryClient();
  const [agentFilter, setAgentFilter] = useState('');
  const [phoneFilter, setPhoneFilter] = useState('');
  const [page, setPage] = useState(0);
  const [preview, setPreview] = useState<Conversation | null>(null);

  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: api.getAgents });

  const params: Record<string, string> = { page: String(page), limit: '50' };
  if (agentFilter) params.agentId = agentFilter;
  if (phoneFilter) params.senderPhone = phoneFilter;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ['conversations', params],
    queryFn: () => api.getConversations(params),
  });

  const clearSession = useMutation({
    mutationFn: ({ agentId, conversationId }: { agentId: string; conversationId: string }) =>
      api.clearSession(agentId, conversationId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['conversations'] }); message.success('Sessão limpa.'); },
    onError: (e: Error) => message.error(e.message),
  });

  const agentName = (id: string) => agents.find(a => a._id === id)?.name ?? id;

  const cols = [
    {
      title: 'Telefone', dataIndex: 'senderPhone', key: 'phone', width: 150,
      render: (p: string, c: Conversation) => (
        <div>
          <Text strong>{p}</Text>
          {c.senderName && <div><Text type="secondary" style={{ fontSize: 12 }}>{c.senderName}</Text></div>}
        </div>
      ),
    },
    {
      title: 'Agente', dataIndex: 'agentId', key: 'agent',
      render: (id: string) => <Tag color="blue">{agentName(id)}</Tag>,
    },
    {
      title: 'Mensagens', dataIndex: 'messages', key: 'msgs',
      render: (msgs: Conversation['messages']) => (
        <Text type="secondary">{msgs?.length ?? 0} mensagens</Text>
      ),
    },
    {
      title: 'Conv. Chatwoot', dataIndex: 'chatwootConvId', key: 'cwid', width: 130,
      render: (id: number) => id ? <Text code style={{ fontSize: 12 }}>#{id}</Text> : '—',
    },
    {
      title: 'Atualizado', dataIndex: 'updatedAt', key: 'updated', width: 130,
      render: (d: string) => d ? dayjs(d).format('DD/MM HH:mm') : '—',
    },
    {
      title: 'Ações', key: 'actions', width: 140,
      render: (_: unknown, c: Conversation) => (
        <Space>
          <Button size="small" icon={<EyeOutlined />} onClick={() => setPreview(c)}>Ver</Button>
          <Popconfirm
            title="Limpar sessão Redis?"
            description="O agente perderá o contexto desta conversa."
            onConfirm={() => clearSession.mutate({ agentId: c.agentId, conversationId: String(c.chatwootConvId ?? c._id) })}
            okText="Limpar"
            okButtonProps={{ danger: true }}
          >
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <Title level={3} style={{ margin: 0 }}><MessageOutlined /> Conversas</Title>
        <Button icon={<ReloadOutlined />} onClick={() => refetch()}>Atualizar</Button>
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Filtrar por agente"
          value={agentFilter || undefined}
          onChange={v => { setAgentFilter(v ?? ''); setPage(0); }}
          allowClear
          style={{ width: 200 }}
          options={agents.map(a => ({ value: a._id, label: a.name }))}
        />
        <Input.Search
          placeholder="Filtrar por telefone"
          value={phoneFilter}
          onChange={e => setPhoneFilter(e.target.value)}
          onSearch={() => setPage(0)}
          allowClear
          style={{ width: 200 }}
        />
      </Space>

      <Table
        rowKey="_id"
        dataSource={data?.data ?? []}
        columns={cols}
        loading={isLoading}
        pagination={{
          total: data?.total ?? 0,
          pageSize: 50,
          current: page + 1,
          onChange: p => setPage(p - 1),
          showTotal: t => `${t} conversas`,
        }}
        locale={{ emptyText: 'Nenhuma conversa encontrada.' }}
      />

      <Modal
        title={`Conversa com ${preview?.senderPhone ?? ''}`}
        open={!!preview}
        onCancel={() => setPreview(null)}
        footer={null}
        width={600}
      >
        {preview && (
          <div style={{ maxHeight: 480, overflowY: 'auto', padding: '8px 0' }}>
            {(preview.messages ?? []).map((m, i) => (
              <div key={i} style={{
                display: 'flex',
                justifyContent: m.role === 'user' ? 'flex-start' : 'flex-end',
                marginBottom: 8,
              }}>
                <div style={{
                  background: m.role === 'user' ? '#f0f0f0' : '#1677ff',
                  color: m.role === 'user' ? '#000' : '#fff',
                  borderRadius: 12,
                  padding: '8px 12px',
                  maxWidth: '75%',
                  fontSize: 13,
                  whiteSpace: 'pre-wrap',
                }}>
                  {typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}
                </div>
              </div>
            ))}
            {preview.messages?.length === 0 && (
              <Paragraph type="secondary" style={{ textAlign: 'center' }}>Sem mensagens neste registro.</Paragraph>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
