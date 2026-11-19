/** UI strings. Answers follow the user's language automatically; this only covers the chrome. */
export interface Strings {
  openChat: string;
  closeChat: string;
  newChat: string;
  history: string;
  back: string;
  placeholder: string;
  send: string;
  stop: string;
  sources: string;
  copy: string;
  copied: string;
  helpful: string;
  notHelpful: string;
  thanks: string;
  retry: string;
  thinking: string;
  searching: string;
  noConversations: string;
  deleteConversation: string;
  errorGeneric: string;
  errorRateLimited: string;
  errorBudget: string;
  errorNetwork: string;
  errorUnavailable: string;
  stopped: string;
  untitled: string;
  expand: string;
  collapse: string;
  answerReady: string;
  poweredBy: string;
  talkToHuman: string;
  approvalNeeded: string;
  allow: string;
  deny: string;
  declined: string;
  approved: string;
  related: string;
  working: string;
  handoffFailed: string;
  /** `{name}` is replaced with the person's name. */
  agentJoined: string;
  backToAssistant: string;
  messagePerson: string;
}

const en: Strings = {
  openChat: "Open chat",
  closeChat: "Close chat",
  newChat: "New chat",
  history: "Conversations",
  back: "Back",
  placeholder: "Ask a question…",
  send: "Send",
  stop: "Stop generating",
  sources: "Sources",
  copy: "Copy",
  copied: "Copied",
  helpful: "Helpful",
  notHelpful: "Not helpful",
  thanks: "Thanks for the feedback",
  retry: "Try again",
  thinking: "Thinking…",
  searching: "Searching…",
  noConversations: "No conversations yet.",
  deleteConversation: "Delete conversation",
  errorGeneric: "Something went wrong. Please try again.",
  errorRateLimited: "You're sending messages too quickly. Please wait a moment.",
  errorBudget: "The assistant is unavailable right now. Please try again later.",
  errorNetwork: "Connection problem. Check your network and try again.",
  errorUnavailable: "The assistant is not available on this page.",
  stopped: "Stopped.",
  untitled: "New conversation",
  expand: "Expand",
  collapse: "Collapse",
  answerReady: "Answer ready",
  poweredBy: "AI assistant",
  talkToHuman: "Talk to a person",
  approvalNeeded: "Allow this action?",
  allow: "Allow",
  deny: "Don't allow",
  declined: "Not allowed",
  approved: "Allowed",
  related: "Related questions",
  working: "Working…",
  handoffFailed: "Couldn't reach the team. Please try again.",
  agentJoined: "{name} joined the conversation",
  backToAssistant: "You are chatting with the assistant again",
  messagePerson: "Message {name}…",
};

const zh: Strings = {
  openChat: "打开聊天",
  closeChat: "关闭聊天",
  newChat: "新对话",
  history: "对话记录",
  back: "返回",
  placeholder: "输入你的问题…",
  send: "发送",
  stop: "停止生成",
  sources: "来源",
  copy: "复制",
  copied: "已复制",
  helpful: "有帮助",
  notHelpful: "没帮助",
  thanks: "感谢你的反馈",
  retry: "重试",
  thinking: "思考中…",
  searching: "正在查找资料…",
  noConversations: "还没有对话。",
  deleteConversation: "删除对话",
  errorGeneric: "出了点问题，请重试。",
  errorRateLimited: "发送太频繁了，请稍等片刻。",
  errorBudget: "助手暂时不可用，请稍后再试。",
  errorNetwork: "网络连接有问题，请检查网络后重试。",
  errorUnavailable: "此页面无法使用该助手。",
  stopped: "已停止。",
  untitled: "新对话",
  expand: "展开",
  collapse: "收起",
  answerReady: "回答已生成",
  poweredBy: "AI 助手",
  talkToHuman: "联系人工客服",
  approvalNeeded: "允许执行此操作吗？",
  allow: "允许",
  deny: "不允许",
  declined: "已拒绝",
  approved: "已允许",
  related: "相关问题",
  working: "处理中…",
  handoffFailed: "无法联系团队，请重试。",
  agentJoined: "{name} 已加入对话",
  backToAssistant: "已切换回 AI 助手",
  messagePerson: "给 {name} 发消息…",
};

const it: Strings = {
  openChat: "Apri la chat",
  closeChat: "Chiudi la chat",
  newChat: "Nuova chat",
  history: "Conversazioni",
  back: "Indietro",
  placeholder: "Fai una domanda…",
  send: "Invia",
  stop: "Interrompi",
  sources: "Fonti",
  copy: "Copia",
  copied: "Copiato",
  helpful: "Utile",
  notHelpful: "Non utile",
  thanks: "Grazie per il feedback",
  retry: "Riprova",
  thinking: "Sto pensando…",
  searching: "Sto cercando…",
  noConversations: "Ancora nessuna conversazione.",
  deleteConversation: "Elimina conversazione",
  errorGeneric: "Qualcosa è andato storto. Riprova.",
  errorRateLimited: "Stai inviando messaggi troppo velocemente. Attendi un momento.",
  errorBudget: "L'assistente non è disponibile ora. Riprova più tardi.",
  errorNetwork: "Problema di connessione. Controlla la rete e riprova.",
  errorUnavailable: "L'assistente non è disponibile su questa pagina.",
  stopped: "Interrotto.",
  untitled: "Nuova conversazione",
  expand: "Espandi",
  collapse: "Riduci",
  answerReady: "Risposta pronta",
  poweredBy: "Assistente IA",
  talkToHuman: "Parla con una persona",
  approvalNeeded: "Consentire questa azione?",
  allow: "Consenti",
  deny: "Non consentire",
  declined: "Non consentita",
  approved: "Consentita",
  related: "Domande correlate",
  working: "In corso…",
  handoffFailed: "Impossibile contattare il team. Riprova.",
  agentJoined: "{name} si è unito alla conversazione",
  backToAssistant: "Stai di nuovo parlando con l'assistente",
  messagePerson: "Scrivi a {name}…",
};

const es: Strings = {
  openChat: "Abrir chat",
  closeChat: "Cerrar chat",
  newChat: "Nuevo chat",
  history: "Conversaciones",
  back: "Atrás",
  placeholder: "Haz una pregunta…",
  send: "Enviar",
  stop: "Detener",
  sources: "Fuentes",
  copy: "Copiar",
  copied: "Copiado",
  helpful: "Útil",
  notHelpful: "No es útil",
  thanks: "Gracias por tu opinión",
  retry: "Reintentar",
  thinking: "Pensando…",
  searching: "Buscando…",
  noConversations: "Aún no hay conversaciones.",
  deleteConversation: "Eliminar conversación",
  errorGeneric: "Algo salió mal. Inténtalo de nuevo.",
  errorRateLimited: "Estás enviando mensajes demasiado rápido. Espera un momento.",
  errorBudget: "El asistente no está disponible ahora. Inténtalo más tarde.",
  errorNetwork: "Problema de conexión. Revisa tu red e inténtalo de nuevo.",
  errorUnavailable: "El asistente no está disponible en esta página.",
  stopped: "Detenido.",
  untitled: "Nueva conversación",
  expand: "Ampliar",
  collapse: "Reducir",
  answerReady: "Respuesta lista",
  poweredBy: "Asistente de IA",
  talkToHuman: "Hablar con una persona",
  approvalNeeded: "¿Permitir esta acción?",
  allow: "Permitir",
  deny: "No permitir",
  declined: "No permitida",
  approved: "Permitida",
  related: "Preguntas relacionadas",
  working: "Procesando…",
  handoffFailed: "No se pudo contactar al equipo. Inténtalo de nuevo.",
  agentJoined: "{name} se unió a la conversación",
  backToAssistant: "Vuelves a hablar con el asistente",
  messagePerson: "Escribe a {name}…",
};

const fr: Strings = {
  openChat: "Ouvrir le chat",
  closeChat: "Fermer le chat",
  newChat: "Nouvelle discussion",
  history: "Conversations",
  back: "Retour",
  placeholder: "Posez une question…",
  send: "Envoyer",
  stop: "Arrêter",
  sources: "Sources",
  copy: "Copier",
  copied: "Copié",
  helpful: "Utile",
  notHelpful: "Pas utile",
  thanks: "Merci pour votre avis",
  retry: "Réessayer",
  thinking: "Réflexion…",
  searching: "Recherche…",
  noConversations: "Aucune conversation pour l'instant.",
  deleteConversation: "Supprimer la conversation",
  errorGeneric: "Une erreur s'est produite. Veuillez réessayer.",
  errorRateLimited: "Vous envoyez des messages trop vite. Patientez un instant.",
  errorBudget: "L'assistant est indisponible pour le moment. Réessayez plus tard.",
  errorNetwork: "Problème de connexion. Vérifiez votre réseau et réessayez.",
  errorUnavailable: "L'assistant n'est pas disponible sur cette page.",
  stopped: "Arrêté.",
  untitled: "Nouvelle conversation",
  expand: "Agrandir",
  collapse: "Réduire",
  answerReady: "Réponse prête",
  poweredBy: "Assistant IA",
  talkToHuman: "Parler à une personne",
  approvalNeeded: "Autoriser cette action ?",
  allow: "Autoriser",
  deny: "Ne pas autoriser",
  declined: "Refusée",
  approved: "Autorisée",
  related: "Questions associées",
  working: "En cours…",
  handoffFailed: "Impossible de joindre l'équipe. Réessayez.",
  agentJoined: "{name} a rejoint la conversation",
  backToAssistant: "Vous discutez de nouveau avec l'assistant",
  messagePerson: "Écrire à {name}…",
};

const de: Strings = {
  openChat: "Chat öffnen",
  closeChat: "Chat schließen",
  newChat: "Neuer Chat",
  history: "Unterhaltungen",
  back: "Zurück",
  placeholder: "Stellen Sie eine Frage…",
  send: "Senden",
  stop: "Stoppen",
  sources: "Quellen",
  copy: "Kopieren",
  copied: "Kopiert",
  helpful: "Hilfreich",
  notHelpful: "Nicht hilfreich",
  thanks: "Danke für Ihr Feedback",
  retry: "Erneut versuchen",
  thinking: "Denke nach…",
  searching: "Suche…",
  noConversations: "Noch keine Unterhaltungen.",
  deleteConversation: "Unterhaltung löschen",
  errorGeneric: "Etwas ist schiefgelaufen. Bitte erneut versuchen.",
  errorRateLimited: "Sie senden zu schnell. Bitte warten Sie kurz.",
  errorBudget: "Der Assistent ist gerade nicht verfügbar. Bitte später erneut versuchen.",
  errorNetwork: "Verbindungsproblem. Prüfen Sie Ihr Netzwerk und versuchen Sie es erneut.",
  errorUnavailable: "Der Assistent ist auf dieser Seite nicht verfügbar.",
  stopped: "Gestoppt.",
  untitled: "Neue Unterhaltung",
  expand: "Vergrößern",
  collapse: "Verkleinern",
  answerReady: "Antwort bereit",
  poweredBy: "KI-Assistent",
  talkToHuman: "Mit einer Person sprechen",
  approvalNeeded: "Diese Aktion erlauben?",
  allow: "Erlauben",
  deny: "Nicht erlauben",
  declined: "Abgelehnt",
  approved: "Erlaubt",
  related: "Ähnliche Fragen",
  working: "Wird ausgeführt…",
  handoffFailed: "Das Team ist nicht erreichbar. Bitte erneut versuchen.",
  agentJoined: "{name} ist dem Gespräch beigetreten",
  backToAssistant: "Sie chatten wieder mit dem Assistenten",
  messagePerson: "Nachricht an {name}…",
};

const ja: Strings = {
  openChat: "チャットを開く",
  closeChat: "チャットを閉じる",
  newChat: "新しいチャット",
  history: "会話履歴",
  back: "戻る",
  placeholder: "質問を入力…",
  send: "送信",
  stop: "生成を停止",
  sources: "出典",
  copy: "コピー",
  copied: "コピーしました",
  helpful: "役に立った",
  notHelpful: "役に立たなかった",
  thanks: "フィードバックありがとうございます",
  retry: "再試行",
  thinking: "考えています…",
  searching: "検索しています…",
  noConversations: "まだ会話はありません。",
  deleteConversation: "会話を削除",
  errorGeneric: "問題が発生しました。もう一度お試しください。",
  errorRateLimited: "送信が速すぎます。少し待ってからお試しください。",
  errorBudget: "現在アシスタントは利用できません。後でもう一度お試しください。",
  errorNetwork: "接続に問題があります。ネットワークを確認してください。",
  errorUnavailable: "このページではアシスタントを利用できません。",
  stopped: "停止しました。",
  untitled: "新しい会話",
  expand: "拡大",
  collapse: "縮小",
  answerReady: "回答の準備ができました",
  poweredBy: "AIアシスタント",
  talkToHuman: "担当者と話す",
  approvalNeeded: "この操作を許可しますか？",
  allow: "許可する",
  deny: "許可しない",
  declined: "拒否しました",
  approved: "許可しました",
  related: "関連する質問",
  working: "処理中…",
  handoffFailed: "チームに連絡できませんでした。もう一度お試しください。",
  agentJoined: "{name} が会話に参加しました",
  backToAssistant: "アシスタントとの会話に戻りました",
  messagePerson: "{name} にメッセージ…",
};

const pt: Strings = {
  openChat: "Abrir chat",
  closeChat: "Fechar chat",
  newChat: "Novo chat",
  history: "Conversas",
  back: "Voltar",
  placeholder: "Faça uma pergunta…",
  send: "Enviar",
  stop: "Parar",
  sources: "Fontes",
  copy: "Copiar",
  copied: "Copiado",
  helpful: "Útil",
  notHelpful: "Não foi útil",
  thanks: "Obrigado pelo feedback",
  retry: "Tentar novamente",
  thinking: "Pensando…",
  searching: "Pesquisando…",
  noConversations: "Ainda não há conversas.",
  deleteConversation: "Excluir conversa",
  errorGeneric: "Algo deu errado. Tente novamente.",
  errorRateLimited: "Você está enviando mensagens rápido demais. Aguarde um momento.",
  errorBudget: "O assistente não está disponível agora. Tente mais tarde.",
  errorNetwork: "Problema de conexão. Verifique sua rede e tente novamente.",
  errorUnavailable: "O assistente não está disponível nesta página.",
  stopped: "Interrompido.",
  untitled: "Nova conversa",
  expand: "Expandir",
  collapse: "Recolher",
  answerReady: "Resposta pronta",
  poweredBy: "Assistente de IA",
  talkToHuman: "Falar com uma pessoa",
  approvalNeeded: "Permitir esta ação?",
  allow: "Permitir",
  deny: "Não permitir",
  declined: "Não permitida",
  approved: "Permitida",
  related: "Perguntas relacionadas",
  working: "Processando…",
  handoffFailed: "Não foi possível contatar a equipe. Tente novamente.",
  agentJoined: "{name} entrou na conversa",
  backToAssistant: "Você está conversando com o assistente novamente",
  messagePerson: "Mensagem para {name}…",
};

const TABLE: Record<string, Strings> = { en, zh, it, es, fr, de, ja, pt };

/** Pick strings for a BCP 47 tag (e.g. "zh-CN" -> zh), falling back to English. */
export function stringsFor(...candidates: (string | null | undefined)[]): { lang: string; t: Strings } {
  for (const c of candidates) {
    if (!c) continue;
    const base = c.toLowerCase().split(/[-_]/)[0]!;
    if (TABLE[base]) return { lang: base, t: TABLE[base] };
  }
  return { lang: "en", t: en };
}

export const SUPPORTED_LOCALES = Object.keys(TABLE);
