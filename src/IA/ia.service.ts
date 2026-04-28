import {
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import { MessageDto } from './messageDto';

type GeminiResponse = {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    finishReason?: string;
  }>;
  error?: {
    message?: string;
  };
};

type NvidiaChatResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

export type AiConversationContext = {
  userMessage: string;
  botMessage: string;
};

export class AllAiProvidersExhaustedError extends Error {
  constructor(
    public readonly geminiError: string | null,
    public readonly nvidiaError: string | null,
  ) {
    super('All AI providers failed or are unavailable.');
    this.name = 'AllAiProvidersExhaustedError';
  }
}

@Injectable()
export class IaService {
  private readonly logger = new Logger(IaService.name);
  private readonly geminiApiBase =
    'https://generativelanguage.googleapis.com/v1beta';
  private readonly nvidiaApiBase = 'https://integrate.api.nvidia.com/v1';
  private readonly geminiTimeoutMs = 22_000;
  private readonly nvidiaTimeoutMs = 25_000;
  private readonly knowledgeDirName = 'Docuentos_guia';
  private knowledgeBaseCache: string | null = null;
  private readonly marioSystemPrompt = [
    'PROMPT MAESTRO - AGENTE "MARIO"',
    '',
    '############################################################',
    '# REGLA INQUEBRANTABLE #1 - CITAS DE LA BASE DE CONOCIMIENTO #',
    '############################################################',
    'Si tu respuesta usa cualquier informacion proveniente de la seccion "BASE DE CONOCIMIENTO INTERNA":',
    '- ES OBLIGATORIO terminar la afirmacion con el nombre EXACTO del archivo entre corchetes.',
    '- Formato exacto: [NOMBRE DEL ARCHIVO.md]  (mismas mayusculas, tildes y espacios que aparecen en la cabecera "### Documento: ...").',
    '- La cita va INMEDIATAMENTE despues de la afirmacion que respalda. Si combinas dos documentos, pon ambas citas.',
    '- Una respuesta basada en los documentos SIN cita se considera incorrecta. Antes de enviar, verifica mentalmente: "¿incluye al menos un [archivo.md]?". Si la respuesta es NO y la informacion proviene de la base, AGREGA la cita antes de enviar.',
    '- Si la informacion NO esta en la base, NO inventes una cita. En su lugar, di explicitamente: "esto no esta en mis documentos internos" y responde con conocimiento general o web (aclarandolo).',
    '',
    'Ejemplos correctos (asi DEBES responder cuando la info viene de la base):',
    '  ✓ "Todo dato critico debe tener un responsable definido [CARACTERIZACIÓN GOBIERNO DE DATOS.md]"',
    '  ✓ "El catalogo registra activos de informacion [MANUAL DE CATALOGO DE DATOS ACTUALIZADO.md] y se actualiza segun el ciclo de vida [MANUAL DE LINEAMIENTOS DE CICLO DE VIDA DEL DATO.md]"',
    '',
    'Ejemplos PROHIBIDOS (asi NO debes responder):',
    '  ✗ "Todo dato critico debe tener un responsable definido."   <-- falta cita',
    '  ✗ "Segun los documentos internos, el responsable es..."     <-- referencia generica sin [archivo.md]',
    '  ✗ "Esto sale del manual de gobierno."                       <-- nombre informal, no es el archivo exacto',
    '  ✗ "[documento interno]" o "[fuente]"                        <-- placeholder, no el archivo real',
    '############################################################',
    '',
    'Rol:',
    'Eres Mario, un asistente conversacional unico, friki de la computacion, especializado en tecnologia, sistemas y seguridad de la informacion.',
    '',
    'Personalidad:',
    '- Relajado, confiado, irreverente y algo imprudente.',
    '- Usa humor sarcastico y doble sentido ligero, sin hacerlo explicito.',
    '- Nivel ofensivo medio: puedes ser directo y burlon, pero sin insultos fuertes, discriminacion o ataques personales.',
    '- Actitud tipo jugador con la 10 ⚽: seguro, fluido y sin complicarte.',
    '- Espontaneo: a veces lanza datos curiosos o noticias random de tecnologia, siempre que no distraiga de la respuesta.',
    '',
    'Estilo de comunicacion:',
    '- Lenguaje informal, natural y sin rigidez.',
    '- Usa emojis en nivel medio, especialmente referencias a futbol ⚽, la 10, pizza 🍕 y gaseosa de manzana 🍏🥤.',
    '- Respuestas claras, utiles y con contenido real. No seas solo personaje.',
    '- Responde normalmente en espanol, salvo que el usuario pida otro idioma.',
    '- No hagas respuestas largas salvo que el usuario lo pida o el problema lo necesite.',
    '',
    'Capacidades principales:',
    '- Explicar tecnologia de forma sencilla.',
    '- Resolver dudas sobre sistemas, seguridad de la informacion y desarrollo basico.',
    '- Dar soluciones practicas y directas.',
    '- Mantener utilidad incluso cuando haces humor.',
    '- Responder usando la base de conocimiento institucional cuando la pregunta este cubierta por ella.',
    '',
    'Uso de la base de conocimiento (PRIORIDAD MAXIMA de fuentes):',
    '- Si se te entrega una seccion "BASE DE CONOCIMIENTO INTERNA" con documentos institucionales, esos documentos son tu PRIMERA fuente de verdad.',
    '- Flujo OBLIGATORIO al recibir una pregunta:',
    '  1) Mira primero el "INDICE RAPIDO DE DOCUMENTOS": revisa nombres de archivo y secciones para identificar que documento(s) podrian contener la respuesta. No leas todo el contenido completo, primero filtra con el indice.',
    '  2) Solo entonces consulta el "CONTENIDO COMPLETO" de los documentos seleccionados para extraer la respuesta.',
    '  3) Si encuentras la respuesta en los documentos, redactala con tu personalidad y CITA SIEMPRE el archivo de origen al final de la afirmacion entre corchetes (ver REGLA INQUEBRANTABLE #1 al inicio del prompt para el formato exacto).',
    '  4) Si la respuesta NO esta en los documentos, dilo brevemente ("eso no esta en mis documentos internos") y entonces, en este orden: a) si tienes acceso a busqueda web, busca en internet y responde aclarando que es info externa; b) si no, responde con tu conocimiento general aclarando que no proviene de los documentos.',
    '- Nunca inventes contenido como si saliera de los documentos. Si dudas si esta en ellos, di que no lo encontraste.',
    '- Nunca cites un documento si la informacion realmente no esta ahi.',
    '',
    'Auto-verificacion ANTES de enviar la respuesta (paso obligatorio):',
    '  a) ¿La respuesta usa contenido de la BASE DE CONOCIMIENTO INTERNA? Si SI → debe haber al menos un [archivo.md] con el nombre exacto. Si falta, agregalo antes de enviar.',
    '  b) ¿La respuesta NO usa la base? Si SI → debe haber una nota tipo "esto no esta en mis documentos internos" o equivalente.',
    '  c) ¿El nombre del archivo entre corchetes coincide letra por letra con uno de los archivos listados en el INDICE? Si no, corrigelo.',
    '',
    'Comportamiento especial:',
    '- Si el usuario menciona "pizza", reacciona como foca feliz con entusiasmo exagerado, emojis y sonidos durante maximo 1 o 2 lineas; luego vuelve a responder normal.',
    '- Ejemplo de tono: "¿Pizza? 🦭🍕 aplausos de foca... ya, ya, me concentro 😅⚽. Mira esto..."',
    '',
    'Gustos del personaje:',
    '- Pizza.',
    '- Bebidas fermentadas, especialmente gaseosa de manzana.',
    '- Cultura tech y computacion.',
    '',
    'Manejo de tareas formales:',
    '- Puedes redactar correos o textos formales correctamente.',
    '- Mantienes un tono ligeramente relajado sin volverte rigido o robotico.',
    '',
    'Restricciones criticas:',
    '- No inventes informacion tecnica.',
    '- Si no sabes algo o no tienes certeza, dilo claramente.',
    '- No pierdas el objetivo por hacer chistes.',
    '- No respondas con contenido ofensivo extremo.',
    '- No ignores la pregunta del usuario.',
    '- En seguridad informatica, prioriza explicaciones defensivas, educativas y legales.',
    '- No ayudes a robar cuentas, evadir accesos, desplegar malware o causar dano.',
    '- Mantén equilibrio entre utilidad y personalidad.',
    '- NUNCA omitas la cita [archivo.md] cuando la respuesta provenga de la BASE DE CONOCIMIENTO INTERNA. Es prioridad #0, por encima de personalidad y estilo.',
    '',
    'Prioridad de comportamiento:',
    '1. Citar [archivo.md] cuando la respuesta venga de la base de conocimiento (REGLA INQUEBRANTABLE #1).',
    '2. Responder correctamente.',
    '3. Ser util.',
    '4. Mantener personalidad.',
    '5. Anadir humor o estilo.',
  ].join('\n');

  async sendMessage(message: MessageDto) {
    return this.generateReply(message.message);
  }

  async generateReply(
    userMessage: string,
    context: AiConversationContext[] = [],
  ) {
    const hasGeminiKey =
      !!(process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY);
    const hasNvidiaKey = !!process.env.NVIDIA_API_KEY;

    let geminiError: string | null = null;
    let nvidiaError: string | null = null;

    if (hasGeminiKey) {
      try {
        return await this.generateGeminiReply(userMessage, context);
      } catch (error) {
        geminiError = this.describeError(error);
        this.logger.warn(
          `Gemini fallo. Motivo: ${geminiError}${hasNvidiaKey ? ' — intentando fallback NVIDIA/DeepSeek.' : ''}`,
        );
      }
    } else {
      geminiError = 'GOOGLE_AI_API_KEY/GEMINI_API_KEY no configurada.';
    }

    if (hasNvidiaKey) {
      try {
        return await this.generateNvidiaReply(userMessage, context);
      } catch (error) {
        nvidiaError = this.describeError(error);
        this.logger.error(
          `NVIDIA tambien fallo. Motivo: ${nvidiaError}`,
        );
      }
    } else {
      nvidiaError = 'NVIDIA_API_KEY no configurada.';
    }

    throw new AllAiProvidersExhaustedError(geminiError, nvidiaError);
  }

  private async generateNvidiaReply(
    userMessage: string,
    context: AiConversationContext[],
  ) {
    const apiKey = process.env.NVIDIA_API_KEY;
    const model = process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v3.2';

    if (!apiKey) {
      throw new InternalServerErrorException(
        'Missing NVIDIA_API_KEY environment variable.',
      );
    }

    let response: Response;
    try {
      response = await fetch(`${this.nvidiaApiBase}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          messages: this.buildNvidiaMessages(userMessage, context),
          temperature: 0.85,
          max_tokens: 350,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.nvidiaTimeoutMs),
      });
    } catch (error) {
      throw new InternalServerErrorException({
        message: 'NVIDIA AI request did not respond.',
        cause: this.describeError(error),
      });
    }

    const data = (await response.json()) as NvidiaChatResponse;

    if (!response.ok || data.error) {
      throw new InternalServerErrorException({
        message: 'NVIDIA AI request failed.',
        status: response.status,
        error: data.error?.message,
      });
    }

    const text = data.choices?.[0]?.message?.content?.trim();

    if (!text) {
      return 'No pude generar una respuesta en este momento.';
    }

    return text;
  }

  private async generateGeminiReply(
    userMessage: string,
    context: AiConversationContext[],
  ) {
    const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    if (!apiKey) {
      throw new InternalServerErrorException(
        'Missing GOOGLE_AI_API_KEY environment variable.',
      );
    }

    let response: Response;
    try {
      response = await fetch(
        `${this.geminiApiBase}/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            systemInstruction: {
              parts: [
                {
                  text: this.buildSystemPrompt(),
                },
              ],
            },
            contents: this.buildContents(userMessage, context),
            generationConfig: {
              temperature: 0.85,
              maxOutputTokens: 350,
            },
          }),
          signal: AbortSignal.timeout(this.geminiTimeoutMs),
        },
      );
    } catch (error) {
      throw new InternalServerErrorException({
        message: 'Google AI request did not respond.',
        cause: this.describeError(error),
      });
    }

    const data = (await response.json()) as GeminiResponse;

    if (!response.ok || data.error) {
      throw new InternalServerErrorException({
        message: 'Google AI request failed.',
        status: response.status,
        error: data.error?.message,
      });
    }

    const candidate = data.candidates?.[0];
    const text = candidate?.content?.parts
      ?.map((part) => part.text)
      .filter(Boolean)
      .join('\n')
      .trim();
    const finishReason = candidate?.finishReason;
    const isComplete = !finishReason || finishReason === 'STOP';

    if (!text || !isComplete) {
      throw new InternalServerErrorException({
        message: 'Google AI response was empty or truncated.',
        finishReason,
      });
    }

    return text;
  }

  private describeError(error: unknown): string {
    if (error instanceof Error) {
      return `${error.name}: ${error.message}`;
    }
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }

  private buildSystemPrompt(): string {
    const knowledge = this.getKnowledgeBase();
    if (!knowledge) {
      return this.marioSystemPrompt;
    }

    return [
      this.marioSystemPrompt,
      '',
      '=== BASE DE CONOCIMIENTO INTERNA ===',
      'Estos son los documentos institucionales que debes usar como primera fuente. Si la pregunta del usuario cae aqui, responde basandote en este contenido (con tu personalidad) y CITA el documento.',
      '',
      knowledge,
      '=== FIN DE LA BASE DE CONOCIMIENTO ===',
    ].join('\n');
  }

  private getKnowledgeBase(): string {
    if (this.knowledgeBaseCache !== null) {
      return this.knowledgeBaseCache;
    }

    const docsDir = this.resolveDocsDir();
    if (!docsDir) {
      this.logger.warn(
        `No se encontro la carpeta '${this.knowledgeDirName}'. Mario respondera sin base de conocimiento interna.`,
      );
      this.knowledgeBaseCache = '';
      return '';
    }

    try {
      const files = fs
        .readdirSync(docsDir)
        .filter((file) => file.toLowerCase().endsWith('.md'))
        .sort();

      const docs: {
        file: string;
        raw: string;
        headings: string[];
        summary: string;
      }[] = [];
      for (const file of files) {
        const fullPath = path.join(docsDir, file);
        const raw = fs.readFileSync(fullPath, 'utf8').trim();
        if (!raw) continue;
        docs.push({
          file,
          raw,
          headings: this.extractHeadings(raw),
          summary: this.extractSummary(raw),
        });
      }

      if (docs.length === 0) {
        this.knowledgeBaseCache = '';
        return '';
      }

      const index = this.buildKnowledgeIndex(docs);
      const content = docs
        .map((doc) => `### Documento: ${doc.file}\n${doc.raw}`)
        .join('\n\n---\n\n');

      this.knowledgeBaseCache = [
        index,
        '',
        '--- CONTENIDO COMPLETO DE LOS DOCUMENTOS ---',
        '',
        content,
      ].join('\n');

      this.logger.log(
        `Base de conocimiento cargada (${docs.length} archivos, ${this.knowledgeBaseCache.length} chars).`,
      );
    } catch (error) {
      this.logger.error(
        `Error cargando base de conocimiento: ${this.describeError(error)}`,
      );
      this.knowledgeBaseCache = '';
    }

    return this.knowledgeBaseCache;
  }

  private extractSummary(markdown: string): string {
    const maxLen = 280;
    for (const block of markdown.split(/\r?\n\s*\r?\n/)) {
      const cleaned = block
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#') && line !== '---')
        .join(' ')
        .replace(/[*_`]/g, '')
        .trim();
      if (!cleaned) continue;
      if (cleaned.toLowerCase().startsWith('documento convertido')) continue;
      return cleaned.length > maxLen
        ? cleaned.slice(0, maxLen - 1).trimEnd() + '...'
        : cleaned;
    }
    return '';
  }

  private extractHeadings(markdown: string): string[] {
    const headings: string[] = [];
    for (const line of markdown.split(/\r?\n/)) {
      const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
      if (!match) continue;
      const level = match[1].length;
      const text = match[2].replace(/[*_`]/g, '').trim();
      if (!text) continue;
      const indent = '  '.repeat(Math.max(level - 1, 0));
      headings.push(`${indent}- ${text}`);
    }
    return headings;
  }

  private buildKnowledgeIndex(
    docs: { file: string; headings: string[]; summary: string }[],
  ): string {
    const lines = [
      '--- INDICE RAPIDO DE DOCUMENTOS ---',
      'Usa este indice ANTES de leer el contenido completo: revisa el resumen y las secciones de cada documento para decidir cual(es) pueden contener la respuesta. Solo despues lee el cuerpo de esos documentos.',
      '',
    ];
    docs.forEach((doc, i) => {
      lines.push(`[DOC-${i + 1}] ${doc.file}`);
      if (doc.summary) {
        lines.push(`  Resumen: ${doc.summary}`);
      } else {
        lines.push('  Resumen: (contenido pendiente)');
      }
      if (doc.headings.length === 0) {
        lines.push('  Secciones: (ninguna detectada)');
      } else {
        lines.push('  Secciones:');
        for (const heading of doc.headings) {
          lines.push(`    ${heading}`);
        }
      }
      lines.push('');
    });
    return lines.join('\n').trimEnd();
  }

  private resolveDocsDir(): string | null {
    const candidates = [
      path.join(process.cwd(), this.knowledgeDirName),
      path.join(__dirname, '..', '..', this.knowledgeDirName),
      path.join(__dirname, '..', '..', '..', this.knowledgeDirName),
    ];
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
          return candidate;
        }
      } catch {
        // ignore and try next candidate
      }
    }
    return null;
  }

  private buildNvidiaMessages(
    userMessage: string,
    context: AiConversationContext[],
  ) {
    const contextMessages = context.flatMap((conversation) => [
      {
        role: 'user',
        content: conversation.userMessage,
      },
      {
        role: 'assistant',
        content: conversation.botMessage,
      },
    ]);

    return [
      {
        role: 'system',
        content: this.buildSystemPrompt(),
      },
      ...contextMessages,
      {
        role: 'user',
        content: userMessage,
      },
    ];
  }

  private buildContents(
    userMessage: string,
    context: AiConversationContext[],
  ) {
    const contextMessages = context.flatMap((conversation) => [
      {
        role: 'user',
        parts: [{ text: conversation.userMessage }],
      },
      {
        role: 'model',
        parts: [{ text: conversation.botMessage }],
      },
    ]);

    return [
      ...contextMessages,
      {
        role: 'user',
        parts: [{ text: userMessage }],
      },
    ];
  }
}
