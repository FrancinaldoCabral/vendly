import { useState } from 'react';
import {
  Typography, Button, Table, Modal, Form, Input, Select, Space,
  Popconfirm, Tag, message, Alert, Upload,
} from 'antd';
import { PlusOutlined, EditOutlined, DeleteOutlined, BookOutlined, UploadOutlined, PaperClipOutlined, GlobalOutlined, LinkOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import type { KnowledgePoint } from '../lib/types';
import dayjs from 'dayjs';

const { Title, Text, Paragraph } = Typography;
const { TextArea } = Input;

const CATEGORIES = [
  { value: 'business_info', label: 'Informações do negócio' },
  { value: 'product', label: 'Produto / Serviço' },
  { value: 'faq', label: 'FAQ' },
  { value: 'objective_flow', label: 'Fluxo de objetivo' },
  { value: 'customer_profile', label: 'Perfil de cliente' },
  { value: 'general', label: 'Geral' },
];
const catMap = Object.fromEntries(CATEGORIES.map(c => [c.value, c.label]));

export default function KnowledgeBase() {
  const qc = useQueryClient();
  const [agentId, setAgentId] = useState('');
  const [catFilter, setCatFilter] = useState('');
  const [form] = Form.useForm();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<KnowledgePoint | null>(null);
  const [preview, setPreview] = useState<KnowledgePoint | null>(null);
  const [urlOpen, setUrlOpen] = useState(false);
  const [urlForm] = Form.useForm();

  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: api.getAgents });

  const { data, isLoading } = useQuery({
    queryKey: ['knowledge', agentId, catFilter],
    queryFn: () => api.getKnowledge(agentId, catFilter ? { category: catFilter } : undefined),
    enabled: !!agentId,
  });

  const create = useMutation({
    mutationFn: (vals: { title: string; text: string; category: string }) =>
      api.createKnowledge({ ...vals, agentId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge'] }); setOpen(false); message.success('Item criado!'); },
    onError: (e: Error) => message.error(e.message),
  });

  const update = useMutation({
    mutationFn: (vals: { title?: string; text?: string; category?: string }) =>
      api.updateKnowledge(editing!.id, agentId, vals),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge'] }); setOpen(false); message.success('Atualizado!'); },
    onError: (e: Error) => message.error(e.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteKnowledge(id, agentId),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['knowledge'] }); message.success('Removido.'); },
    onError: (e: Error) => message.error(e.message),
  });

  const upload = useMutation({
    mutationFn: (file: File) => new Promise<{ chunkCount: number }>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        api.uploadKnowledge({
          agentId, fileName: file.name, fileBase64: String(reader.result),
          category: catFilter || 'general',
        }).then(resolve).catch(reject);
      };
      reader.onerror = () => reject(new Error('Falha ao ler o arquivo.'));
      reader.readAsDataURL(file);
    }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['knowledge'] }); message.success(`Arquivo importado em ${r.chunkCount} trecho(s).`); },
    onError: (e: Error) => message.error(e.message),
  });

  const addUrl = useMutation({
    mutationFn: (vals: { url: string; title?: string }) =>
      api.addKnowledgeUrl({ agentId, url: vals.url.trim(), title: vals.title?.trim() || undefined, category: catFilter || 'general' }),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['knowledge'] }); message.success(`Site importado em ${r.chunkCount} trecho(s).`); setUrlOpen(false); urlForm.resetFields(); },
    onError: (e: Error) => message.error(e.message),
  });

  const openCreate = () => { form.resetFields(); form.setFieldValue('category', 'general'); setEditing(null); setOpen(true); };
  const openEdit = (kp: KnowledgePoint) => {
    form.setFieldsValue({ title: kp.payload.title, text: kp.payload.text, category: kp.payload.category });
    setEditing(kp);
    setOpen(true);
  };
  const submit = () => form.validateFields().then(vals => { editing ? update.mutate(vals) : create.mutate(vals); });

  const cols = [
    {
      title: 'Título', key: 'title', width: 220,
      render: (_: unknown, kp: KnowledgePoint) => (
        <div>
          <Text strong style={{ fontSize: 13 }}>{kp.payload.title}</Text>
          {kp.payload.source === 'file' && kp.payload.fileName && (
            <div style={{ fontSize: 11, color: '#8c8c8c' }}>
              <PaperClipOutlined /> {kp.payload.fileName}
            </div>
          )}
          {kp.payload.source === 'url' && kp.payload.sourceUrl && (
            <div style={{ fontSize: 11, color: '#8c8c8c', maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              <LinkOutlined /> {kp.payload.sourceUrl}
            </div>
          )}
        </div>
      ),
    },
    {
      title: 'Conteúdo', dataIndex: ['payload', 'text'], key: 'text',
      render: (t: string) => <Text style={{ fontSize: 12 }}>{t.length > 100 ? t.slice(0, 100) + '…' : t}</Text>,
    },
    {
      title: 'Categoria', key: 'cat', width: 180,
      render: (_: unknown, kp: KnowledgePoint) => (
        <Space size={4} wrap>
          <Tag>{catMap[kp.payload.category] ?? kp.payload.category}</Tag>
          {(kp.payload.chunkCount ?? 1) > 1 && (
            <Tag color="purple" style={{ fontSize: 11 }}>{kp.payload.chunkCount} trechos</Tag>
          )}
        </Space>
      ),
    },
    {
      title: 'Criado', dataIndex: ['payload', 'createdAt'], key: 'created',
      render: (d: string) => d ? dayjs(d).format('DD/MM/YY HH:mm') : '—',
      width: 130,
    },
    {
      title: 'Ações', key: 'actions', width: 160,
      render: (_: unknown, kp: KnowledgePoint) => (
        <Space>
          <Button size="small" onClick={() => setPreview(kp)}>Ver</Button>
          <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(kp)} />
          <Popconfirm title="Remover item?" onConfirm={() => remove.mutate(kp.id)}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 8, flexWrap: 'wrap' }}>
        <Title level={3} style={{ margin: 0 }}><BookOutlined /> Base de Conhecimento</Title>
        <Space wrap>
          <Button icon={<GlobalOutlined />} onClick={() => { urlForm.resetFields(); setUrlOpen(true); }} disabled={!agentId}>
            Adicionar site
          </Button>
          <Upload
            showUploadList={false}
            disabled={!agentId || upload.isPending}
            beforeUpload={(file) => { upload.mutate(file as unknown as File); return false; }}
          >
            <Button icon={<UploadOutlined />} loading={upload.isPending} disabled={!agentId}>
              Enviar arquivo
            </Button>
          </Upload>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate} disabled={!agentId}>
            Novo item
          </Button>
        </Space>
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <Select
          placeholder="Selecione um agente"
          value={agentId || undefined}
          onChange={v => setAgentId(v ?? '')}
          style={{ width: 240 }}
          options={agents.map(a => ({ value: a._id, label: a.name }))}
        />
        <Select
          placeholder="Filtrar por categoria"
          value={catFilter || undefined}
          onChange={v => setCatFilter(v ?? '')}
          allowClear
          style={{ width: 220 }}
          options={CATEGORIES}
        />
      </Space>

      {!agentId && (
        <Alert type="info" showIcon message="Selecione um agente para ver e gerenciar sua base de conhecimento." />
      )}

      {agentId && (
        <Table
          rowKey="id"
          dataSource={data?.data ?? []}
          columns={cols}
          loading={isLoading}
          pagination={{ pageSize: 20 }}
          scroll={{ x: 'max-content' }}
          size="middle"
          locale={{ emptyText: 'Nenhum item na base de conhecimento deste agente.' }}
        />
      )}

      <Modal
        title="Adicionar conhecimento de um site"
        open={urlOpen}
        onOk={() => urlForm.validateFields().then(vals => addUrl.mutate(vals as { url: string; title?: string }))}
        onCancel={() => setUrlOpen(false)}
        confirmLoading={addUrl.isPending}
        okText="Importar"
        destroyOnClose
      >
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          Cole o endereço de uma página. Vamos ler o conteúdo dela e adicionar à base de conhecimento deste agente.
        </Paragraph>
        <Form form={urlForm} layout="vertical">
          <Form.Item name="url" label="Endereço (URL)" rules={[{ required: true, message: 'Informe a URL' }]}>
            <Input placeholder="https://seusite.com/pagina" />
          </Form.Item>
          <Form.Item name="title" label="Título (opcional)" extra="Se vazio, usamos o título da página.">
            <Input placeholder="Ex: Política de trocas" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={editing ? 'Editar item' : 'Novo item de conhecimento'}
        open={open}
        onOk={submit}
        onCancel={() => setOpen(false)}
        confirmLoading={create.isPending || update.isPending}
        width={600}
        okText={editing ? 'Salvar' : 'Criar'}
        destroyOnClose
      >
        <Form form={form} layout="vertical" style={{ marginTop: 12 }}>
          <Form.Item name="title" label="Título" rules={[{ required: true }]}>
            <Input placeholder="Ex: Horário de funcionamento" />
          </Form.Item>
          <Form.Item name="category" label="Categoria">
            <Select options={CATEGORIES} />
          </Form.Item>
          <Form.Item name="text" label="Conteúdo" rules={[{ required: true }]}>
            <TextArea rows={6} placeholder="Texto que será indexado e buscado pelo agente…" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title={preview?.payload.title}
        open={!!preview}
        onCancel={() => setPreview(null)}
        footer={null}
      >
        {preview && (
          <>
            <Tag style={{ marginBottom: 8 }}>{catMap[preview.payload.category] ?? preview.payload.category}</Tag>
            <Paragraph style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>{preview.payload.text}</Paragraph>
          </>
        )}
      </Modal>
    </>
  );
}
