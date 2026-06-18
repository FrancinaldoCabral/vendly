import { useEffect, useState } from 'react';
import { Typography, Card, Form, Input, Button, Tag, message, Descriptions, Select, Popconfirm, Space, Alert, List } from 'antd';
import { SettingOutlined, SaveOutlined, ClearOutlined, PauseCircleOutlined, PlayCircleOutlined, CheckCircleOutlined, ToolOutlined } from '@ant-design/icons';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import dayjs from 'dayjs';

const { Title, Paragraph, Text } = Typography;

export default function Settings() {
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const { data: me } = useQuery({ queryKey: ['me'], queryFn: api.getMe });
  const { data: agents = [] } = useQuery({ queryKey: ['agents'], queryFn: api.getAgents });
  const { data: health } = useQuery({ queryKey: ['provisioning-health'], queryFn: api.getProvisioningHealth, refetchInterval: 60_000 });

  const repair = useMutation({
    mutationFn: () => api.repairProvisioning(),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['provisioning-health'] });
      qc.invalidateQueries({ queryKey: ['connections'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
      if (r.ok) message.success(r.fixed.length ? `Resolvido: ${r.fixed.join(' ')}` : 'Tudo certo — nada a corrigir.');
      else message.warning('Alguns itens ainda precisam de atenção. Tente novamente em instantes.');
    },
    onError: (e: Error) => message.error(e.message),
  });

  const [clientAgent, setClientAgent] = useState<string>();
  const [clientPhone, setClientPhone] = useState('');
  const [allAgent, setAllAgent] = useState<string>();

  useEffect(() => {
    if (me) form.setFieldsValue({ name: me.name });
  }, [me, form]);

  const save = useMutation({
    mutationFn: (vals: { name: string }) => api.updateMe({ name: vals.name }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['me'] }); message.success('Configurações salvas!'); },
    onError: (e: Error) => message.error(e.message),
  });

  const clearClient = useMutation({
    mutationFn: () => api.clearAgentHistory(clientAgent!, clientPhone.replace(/\D/g, '')),
    onSuccess: (r) => { message.success(`Histórico do cliente apagado (${r.recordsDeleted} registros).`); setClientPhone(''); },
    onError: (e: Error) => message.error(e.message),
  });

  const clearAll = useMutation({
    mutationFn: () => api.clearAgentHistory(allAgent!),
    onSuccess: (r) => message.success(`Todo o histórico do agente foi apagado (${r.recordsDeleted} registros).`),
    onError: (e: Error) => message.error(e.message),
  });

  const pauseAll = useMutation({
    mutationFn: () => api.pauseAllAgents(),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['agents'] }); message.success(`${r.paused} agente(s) pausado(s). Eles pararam de responder.`); },
    onError: (e: Error) => message.error(e.message),
  });

  const resumeAll = useMutation({
    mutationFn: () => api.resumeAllAgents(),
    onSuccess: (r) => { qc.invalidateQueries({ queryKey: ['agents'] }); message.success(`${r.resumed} agente(s) reativado(s).`); },
    onError: (e: Error) => message.error(e.message),
  });

  const planColor: Record<string, string> = { pro: 'gold', starter: 'blue', free: 'default' };
  const agentOptions = agents.map(a => ({ value: a._id, label: a.name }));

  return (
    <div>
      <Title level={3} style={{ marginTop: 0 }}><SettingOutlined /> Configurações</Title>
      <Paragraph type="secondary">
        Dados da sua conta e ferramentas de manutenção. Para ver as conversas, use a
        <b> Central de Conversas</b> (botão no topo) ou o próprio WhatsApp.
      </Paragraph>

      {health && !health.healthy && (
        <Card style={{ marginBottom: 16, borderColor: '#faad14' }}>
          <Alert
            type="warning"
            showIcon
            message="Há itens de configuração pendentes"
            description={
              <>
                <Paragraph type="secondary" style={{ fontSize: 13, marginBottom: 8 }}>
                  Detectamos provisionamentos que não foram concluídos. Isso pode acontecer por uma
                  instabilidade momentânea durante a configuração. Clique em <b>Resolver</b> para
                  corrigir automaticamente.
                </Paragraph>
                <List
                  size="small"
                  dataSource={health.issues}
                  renderItem={(it) => <List.Item style={{ paddingLeft: 0 }}>• {it.label}</List.Item>}
                  style={{ marginBottom: 8 }}
                />
                <Button type="primary" icon={<ToolOutlined />} loading={repair.isPending} onClick={() => repair.mutate()}>
                  Resolver
                </Button>
              </>
            }
          />
        </Card>
      )}

      {health?.healthy && (
        <Alert
          type="success"
          showIcon
          icon={<CheckCircleOutlined />}
          message="Tudo provisionado e funcionando."
          style={{ marginBottom: 16 }}
        />
      )}

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

      <Card title="Limpar histórico de conversas" style={{ marginBottom: 16 }}>
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          Apaga a memória do agente para começar do zero. O agente esquece o que foi conversado —
          útil quando ele "travou" em algo antigo ou para um novo atendimento limpo. As mensagens no
          WhatsApp do cliente não são apagadas, só a memória interna.
        </Paragraph>

        <Text strong style={{ fontSize: 13 }}>De um cliente específico</Text>
        <Space.Compact style={{ display: 'flex', marginTop: 8, marginBottom: 20, maxWidth: 620, flexWrap: 'wrap' }}>
          <Select placeholder="Escolha o agente" style={{ minWidth: 200 }} options={agentOptions}
            value={clientAgent} onChange={setClientAgent} />
          <Input placeholder="Número do cliente (ex.: 5511999998888)" style={{ flex: 1, minWidth: 220 }}
            value={clientPhone} onChange={e => setClientPhone(e.target.value)} />
          <Popconfirm title="Apagar o histórico deste cliente com este agente?" okText="Apagar" cancelText="Cancelar"
            onConfirm={() => clearClient.mutate()}>
            <Button danger icon={<ClearOutlined />} loading={clearClient.isPending}
              disabled={!clientAgent || clientPhone.replace(/\D/g, '').length < 8}>Limpar</Button>
          </Popconfirm>
        </Space.Compact>

        <div>
          <Text strong style={{ fontSize: 13 }}>De TODOS os clientes de um agente</Text>
          <Space style={{ display: 'flex', marginTop: 8, maxWidth: 620 }}>
            <Select placeholder="Escolha o agente" style={{ minWidth: 200, flex: 1 }} options={agentOptions}
              value={allAgent} onChange={setAllAgent} />
            <Popconfirm title="Apagar TODO o histórico de conversas deste agente? Não há como desfazer." okText="Apagar tudo" cancelText="Cancelar"
              onConfirm={() => clearAll.mutate()}>
              <Button danger icon={<ClearOutlined />} loading={clearAll.isPending} disabled={!allAgent}>Limpar tudo</Button>
            </Popconfirm>
          </Space>
        </div>
      </Card>

      <Card title="Parada total">
        <Paragraph type="secondary" style={{ fontSize: 13 }}>
          Pausa todos os agentes de uma vez — eles param de responder no WhatsApp imediatamente, mas
          o número continua conectado. Use em uma emergência ou fora do horário. Depois é só reativar.
        </Paragraph>
        <Space>
          <Popconfirm title="Pausar TODOS os agentes? Eles param de responder até você reativar." okText="Pausar todos" cancelText="Cancelar"
            onConfirm={() => pauseAll.mutate()}>
            <Button danger icon={<PauseCircleOutlined />} loading={pauseAll.isPending}>Pausar todos os agentes</Button>
          </Popconfirm>
          <Popconfirm title="Reativar todos os agentes pausados?" okText="Reativar" cancelText="Cancelar"
            onConfirm={() => resumeAll.mutate()}>
            <Button type="primary" icon={<PlayCircleOutlined />} loading={resumeAll.isPending}>Reativar todos</Button>
          </Popconfirm>
        </Space>
        <Alert type="info" showIcon style={{ marginTop: 12 }}
          message="Pausar não desconecta o WhatsApp — apenas silencia as respostas automáticas." />
      </Card>
    </div>
  );
}
