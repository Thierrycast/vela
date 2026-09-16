/**
 * O acesso aos sites deixa de vir junto com a instalação.
 *
 * `<all_urls>` no manifest fixo faz o Chrome anunciar, no diálogo de instalação, que a extensão
 * pode "ler e alterar todos os seus dados em todos os sites" — antes de a pessoa ter visto a
 * Vela fazer qualquer coisa. É o pedido mais amplo que existe, feito no pior momento possível
 * para julgá-lo: o momento em que ainda não há nada para julgar.
 *
 * Como `optional_host_permissions`, o mesmo acesso é pedido no primeiro uso, com um clique, por
 * uma tela que explica para que serve. A permissão concedida é idêntica; o que muda é quem
 * escolheu e quando — e que ela pode ser revogada depois sem desinstalar nada.
 *
 * `debugger` continua fixa porque o Chrome **recusa** listá-la como opcional ("Permission
 * 'debugger' cannot be listed as optional"). Ela aparece no diálogo de instalação e continua
 * inerte até alguém ligar o Modo preciso.
 */

const ALL_URLS = { origins: ["<all_urls>"] };

export async function hasHostAccess(): Promise<boolean> {
  if (typeof chrome === "undefined" || !chrome.permissions?.contains) return true;
  try { return await chrome.permissions.contains(ALL_URLS); } catch { return false; }
}

/**
 * Precisa de gesto do usuário: só funciona chamada de dentro de um clique na interface.
 *
 * **Conceder não basta — a extensão precisa reiniciar.** Medido no Chrome: depois de
 * `permissions.request` devolver `true` e `permissions.contains` confirmar, `scripting.executeScript`
 * continuava recusando com "Extension manifest must request permission to access the respective
 * host". O processo que já estava de pé carrega a lista de hosts de quando subiu. Reiniciar é o
 * que faz a permissão nova valer nas APIs — e é barato, porque acontece uma vez, no onboarding.
 */
export async function requestHostAccess(): Promise<boolean> {
  try {
    const granted = await chrome.permissions.request(ALL_URLS);
    if (granted) setTimeout(() => chrome.runtime.reload(), 400);
    return granted;
  } catch { return false; }
}

export async function revokeHostAccess(): Promise<boolean> {
  try { return await chrome.permissions.remove(ALL_URLS); } catch { return false; }
}

export const optionalPermission = async (name: chrome.runtime.ManifestPermission): Promise<boolean> => {
  if (typeof chrome === "undefined" || !chrome.permissions?.contains) return true;
  try { return await chrome.permissions.contains({ permissions: [name] }); } catch { return false; }
};

/**
 * A recusa por falta de acesso precisa dizer o que fazer, e não pode parecer limitação da página.
 * Sem esta distinção o modelo trata como "a Vela não consegue agir aqui" e procura outro caminho —
 * quando o conserto é um clique numa tela de configurações.
 */
export const HOST_ACCESS_MISSING = "A Vela ainda não recebeu permissão para agir nos sites. Isso não é limitação desta página: é uma autorização que fica desligada até o usuário conceder. Peça a ele para abrir Configurações → Permissões e clicar em “Conceder acesso aos sites”. Sem isso, você não consegue ler nem agir em página nenhuma.";
