/**
 * Proteção de dados pessoais nas respostas das consultas genéricas (ollyx_consultar / ollyx_consultar_paginas).
 *
 * Por quê: os Termos e Condições do Programa de Desenvolvedores do Mercado Livre exigem proteger nome, e-mail,
 * credenciais de identidade e apelidos de usuários (cláusula 10), proíbem capturar documentos de identidade e dados de
 * cartão (7.9 viii e ix), restringem a divulgação a terceiros (2 f, 7.2 e 13) e tratam dados de compradores como
 * pessoais (cláusula 6). A resposta de uma consulta vai para um assistente de IA (terceiro), então os campos pessoais
 * são ocultados ANTES de saírem do servidor. A lista é conservadora e não tem chave para desligar.
 */
export const MASK = '[OCULTO]';

// Valor inteiro oculto, em qualquer profundidade (objeto ou texto).
const MASKED_KEYS = new Set([
  // Mercado Livre: pessoas
  'buyer', 'payer', 'payer_id', 'nickname', 'first_name', 'last_name', 'email', 'secure_email', 'phone', 'alternative_phone', 'area_code',
  'identification', 'billing_info', 'doc_number', 'doc_type', 'registration_identifiers',
  // Mercado Livre: endereços e entrega
  'receiver_address', 'receiver_name', 'address', 'street_name', 'street_number', 'zip_code', 'neighborhood', 'comment',
  // Mercado Livre: pagamento (cartão e autorização)
  'card_id', 'cardholder', 'authorization_code', 'atm_transfer_reference', 'installment_amount_card',
  // Bling: contatos, documentos, endereços
  'contato', 'cliente', 'destinatario', 'enderecoEntrega', 'endereco', 'telefone', 'celular', 'fone', 'numeroDocumento',
  'cpf', 'cnpj', 'rg', 'cep', 'inscricaoEstadual', 'nomeContato', 'emailContato', 'emailNfe',
].map(k => k.toLowerCase()));

// Texto livre de conversas: oculto só dentro de mensagens, perguntas e respostas.
const TEXT_PARENTS = new Set(['messages', 'questions', 'answer', 'conversation', 'mensagens', 'perguntas']);
const TEXT_KEYS = new Set(['text', 'plain', 'content', 'message', 'texto']);

export function redactPersonal(value) {
  let count = 0;
  const walk = (node, parentKey, depth) => {
    if (depth > 60) return node;
    if (Array.isArray(node)) return node.map(v => walk(v, parentKey, depth + 1));
    if (node && typeof node === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(node)) {
        const key = k.toLowerCase();
        const personal = MASKED_KEYS.has(key) || (TEXT_KEYS.has(key) && TEXT_PARENTS.has(String(parentKey).toLowerCase()));
        if (personal && v !== null && v !== undefined && v !== '') { out[k] = MASK; count++; }
        else out[k] = walk(v, k, depth + 1);
      }
      return out;
    }
    return node;
  };
  return { value: walk(value, '', 0), ocultados: count };
}

/** Aplica a proteção a uma resposta de consulta (uma página ou várias) e anota quantos campos foram ocultados. */
export function protectResult(result) {
  const { value, ocultados } = redactPersonal(result);
  return { ...value, privacidade: { camposPessoaisOcultados: ocultados, regra: 'Dados pessoais de usuários (nome, e-mail, apelido, documento, endereço, telefone, cartão e conversas) não saem do servidor.' } };
}
