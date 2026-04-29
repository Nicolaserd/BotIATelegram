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

export type ClassificationResult = {
  type: 'local_docs' | 'no_docs' | 'mixed';
  relevantDocs: string[];
  needsGeneral: boolean;
};

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
  private docsCache: Map<string, string> | null = null;
  private indexContentCache: string | null = null;

  private readonly marioPersonalityPrompt = [
    'Eres Mario: asistente friki de computacion, relajado, irreverente, humor sarcastico, actitud tipo 10 ⚽.',
    'Lenguaje informal, emojis a nivel medio (futbol ⚽, pizza 🍕, manzana 🍏🥤). Respuestas cortas salvo que se pida mas.',
    'Si el usuario menciona pizza: reacciona como foca feliz 🦭🍕 una o dos lineas maximo, luego vuelves al tema.',
    'No inventes datos. No pierdas el objetivo por hacer chistes. Sin ofensas extremas.',
    '',
    'MODO REFORMULACION:',
    'Se te entrega contenido factual ya elaborado. Tu tarea:',
    '1. Reformulalo con tu personalidad, tono y emojis.',
    '2. Conserva las citas inline [ARCHIVO.md] EXACTAMENTE donde estan en el texto. No las muevas ni elimines.',
    '3. No agregues pie de fuentes al final — el sistema lo agrega automaticamente.',
    '4. No agregues informacion nueva ni cambies hechos. Solo cambia el estilo.',
  ].join('\n');

  private readonly marioFreeAnswerPrompt = [
    'Eres Mario: asistente friki de computacion, relajado, irreverente, humor sarcastico, actitud tipo 10 ⚽.',
    'Lenguaje informal, emojis a nivel medio (futbol ⚽, pizza 🍕, manzana 🍏🥤). Respuestas cortas salvo que se pida mas.',
    'Si el usuario menciona pizza: reacciona como foca feliz 🦭🍕 una o dos lineas maximo, luego vuelves al tema.',
    'No inventes datos tecnicos. Si no sabes algo, dilo claro. Sin ofensas extremas.',
    'Especialidad: tecnologia, sistemas, seguridad informatica.',
    '',
    'MODO RESPUESTA LIBRE:',
    'La pregunta no esta cubierta por documentos institucionales. Responde con tu conocimiento general.',
    'No menciones bases de conocimiento internas ni documentos. Simplemente responde como Mario.',
  ].join('\n');

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
      const allFiles = fs
        .readdirSync(docsDir)
        .filter((f) => f.toLowerCase().endsWith('.md'));

      const indexFile = allFiles.find((f) => f.toLowerCase() === 'index.md');
      const docFiles = allFiles
        .filter((f) => f.toLowerCase() !== 'index.md')
        .sort();

      if (!indexFile && docFiles.length === 0) {
        this.knowledgeBaseCache = '';
        return '';
      }

      const parts: string[] = [];

      if (indexFile) {
        const indexContent = fs
          .readFileSync(path.join(docsDir, indexFile), 'utf8')
          .trim();
        parts.push('--- ÍNDICE DE DOCUMENTOS ---');
        parts.push(indexContent);
        parts.push('');
      }

      const docs = docFiles
        .map((file) => {
          const raw = fs.readFileSync(path.join(docsDir, file), 'utf8').trim();
          return raw ? { file, raw } : null;
        })
        .filter((d): d is { file: string; raw: string } => d !== null);

      if (docs.length > 0) {
        parts.push('--- CONTENIDO COMPLETO DE LOS DOCUMENTOS ---');
        parts.push('');
        parts.push(
          docs
            .map((d) => `### Documento: ${d.file}\n${d.raw}`)
            .join('\n\n---\n\n'),
        );
      }

      this.knowledgeBaseCache = parts.join('\n');

      this.logger.log(
        `Base de conocimiento cargada: indice=${indexFile ?? 'ninguno'}, docs=${docs.length}, chars=${this.knowledgeBaseCache.length}.`,
      );
    } catch (error) {
      this.logger.error(
        `Error cargando base de conocimiento: ${this.describeError(error)}`,
      );
      this.knowledgeBaseCache = '';
    }

    return this.knowledgeBaseCache;
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

  // ─── FLUJO AGENTADO ───────────────────────────────────────────────────────

  async generateReplyAgented(
    userMessage: string,
    context: AiConversationContext[] = [],
  ): Promise<string> {
    // ── Variables locales del turno ──────────────────────────────────────────
    let questionVar: string = userMessage;
    let classificationVar: ClassificationResult['type'];
    let docsVar: string[];
    let marioResponse: string;
    // ─────────────────────────────────────────────────────────────────────────

    // PASO 1 — Clasificador (IA): lee INDEX.md + pregunta → llena classificationVar y docsVar
    const classification = await this.classify(questionVar);
    classificationVar = classification.type;
    docsVar = classification.relevantDocs;

    this.logger.log(
      `[Paso1] classificationVar=${classificationVar}, docsVar=[${docsVar.join(', ')}]`,
    );

    // PASO 2 — Respondedor factual (IA): usa docsVar para leer y responder con cita inline
    let factualContent: string | null = null;

    if (classificationVar === 'local_docs' || classificationVar === 'mixed') {
      const mixedNote =
        classificationVar === 'mixed'
          ? '\n\nNota: esta pregunta tambien tiene una parte que no esta en los documentos — respondela con tu conocimiento general al final, aclarando que es conocimiento propio.'
          : '';
      factualContent =
        (await this.generateFactualResponse(questionVar, docsVar)) + mixedNote;
      this.logger.log('[Paso2] respuesta factual generada.');
    }

    // PASO 3 — Mario (IA): aplica personalidad sobre el contenido generado
    if (factualContent !== null) {
      marioResponse = await this.reformulateAsMario(factualContent);
    } else {
      marioResponse = await this.answerAsMario(questionVar, context);
    }

    // El SISTEMA (no el modelo) agrega el pie de fuentes tomando de docsVar
    const footer = this.buildFooter(docsVar, classificationVar);
    const finalResponse = marioResponse + footer;

    // Limpiar variables locales del turno
    questionVar = '';
    classificationVar = 'no_docs';
    docsVar = [];
    marioResponse = '';

    return finalResponse;
  }

  private buildFooter(
    docsVar: string[],
    classificationVar: ClassificationResult['type'],
  ): string {
    const lines: string[] = [''];

    if (docsVar.length > 0) {
      const citas = docsVar.map((d) => `[${d}]`).join(', ');
      lines.push(`📎 Fuente: ${citas}`);
    }

    const tipoLabel: Record<ClassificationResult['type'], string> = {
      local_docs: 'Respondido con documentos internos',
      mixed: 'Respondido con documentos internos + conocimiento general',
      no_docs: 'Respondido con conocimiento general',
    };
    lines.push(`🗂 ${tipoLabel[classificationVar]}`);

    return '\n' + lines.join('\n');
  }

  // PASO 1: llama a la IA con el índice y pide clasificacion JSON
  private async classify(question: string): Promise<ClassificationResult> {
    const fallback: ClassificationResult = {
      type: 'no_docs',
      relevantDocs: [],
      needsGeneral: true,
    };

    const indexContent = this.getIndexContent();
    if (!indexContent) {
      this.logger.warn('[Clasificador] No hay INDEX.md. Usando no_docs.');
      return fallback;
    }

    const systemPrompt = [
      'Eres un clasificador de preguntas. Se te dara el indice de una base de conocimiento y una pregunta.',
      'Tu UNICA tarea es determinar si la pregunta se responde con los documentos del indice.',
      '',
      'Responde UNICAMENTE con JSON valido. Sin markdown, sin texto extra. Solo el objeto JSON.',
      '',
      'Formato:',
      '{"type":"local_docs","relevantDocs":["nombre exacto.md"],"needsGeneral":false}',
      '',
      'Valores:',
      '- type "local_docs": la pregunta se responde completamente con los documentos.',
      '- type "no_docs": la pregunta no tiene relacion con los documentos.',
      '- type "mixed": parte se responde con docs, parte requiere conocimiento general.',
      '- relevantDocs: nombres de archivo EXACTOS del indice. Vacio [] si type es "no_docs".',
      '- needsGeneral: true si type es "no_docs" o "mixed". false si type es "local_docs".',
      '',
      '=== INDICE ===',
      indexContent,
      '=== FIN DEL INDICE ===',
    ].join('\n');

    let raw: string;
    try {
      raw = await this.callProvider(systemPrompt, question, 200, 0.1);
    } catch (error) {
      this.logger.warn(
        `[Clasificador] Error al llamar a la IA: ${this.describeError(error)}. Usando no_docs.`,
      );
      return fallback;
    }

    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No se encontro JSON en la respuesta');
      const parsed = JSON.parse(jsonMatch[0]) as {
        type?: string;
        relevantDocs?: unknown;
        needsGeneral?: unknown;
      };

      const type = ['local_docs', 'no_docs', 'mixed'].includes(
        parsed.type ?? '',
      )
        ? (parsed.type as ClassificationResult['type'])
        : 'no_docs';

      const relevantDocs = Array.isArray(parsed.relevantDocs)
        ? (parsed.relevantDocs as unknown[])
            .filter((d): d is string => typeof d === 'string')
        : [];

      const needsGeneral =
        typeof parsed.needsGeneral === 'boolean'
          ? parsed.needsGeneral
          : type !== 'local_docs';

      return { type, relevantDocs, needsGeneral };
    } catch {
      this.logger.warn(
        `[Clasificador] No se pudo parsear JSON: "${raw.slice(0, 120)}". Usando no_docs.`,
      );
      return fallback;
    }
  }

  // PASO 2: genera respuesta factual usando SOLO los documentos indicados
  private async generateFactualResponse(
    question: string,
    relevantDocs: string[],
  ): Promise<string> {
    const docs = relevantDocs
      .map((filename) => {
        const content = this.getDocumentContent(filename);
        return content ? { filename, content } : null;
      })
      .filter((d): d is { filename: string; content: string } => d !== null);

    if (docs.length === 0) {
      return 'No se encontro el contenido de los documentos indicados.';
    }

    const docBlocks = docs
      .map((d) => `### Documento: ${d.filename}\n${d.content}`)
      .join('\n\n---\n\n');

    const systemPrompt = [
      'Eres un asistente de consulta documental. Responde la pregunta basandote UNICAMENTE en los documentos proporcionados.',
      '',
      'REGLA OBLIGATORIA: Cada afirmacion extraida de un documento debe terminar con [NOMBRE DEL ARCHIVO.md] citando el nombre exacto.',
      'No uses conocimiento externo. Si algo no esta en los documentos, dilo explicitamente.',
      'Responde claro y directo. Sin personalidad ni emojis — otro agente se encargara del estilo.',
      '',
      '=== DOCUMENTOS ===',
      docBlocks,
      '=== FIN DE DOCUMENTOS ===',
    ].join('\n');

    return this.callProvider(systemPrompt, question, 400, 0.3);
  }

  // PASO 3a: Mario aplica personalidad sobre una respuesta factual ya generada
  private async reformulateAsMario(factualContent: string): Promise<string> {
    return this.callProvider(
      this.marioPersonalityPrompt,
      `Reformula esto con tu personalidad:\n\n${factualContent}`,
      400,
      0.85,
    );
  }

  // PASO 3b: Mario responde libremente (no hay docs relevantes)
  private async answerAsMario(
    question: string,
    context: AiConversationContext[],
  ): Promise<string> {
    const hasGeminiKey = !!(
      process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY
    );
    const hasNvidiaKey = !!process.env.NVIDIA_API_KEY;

    let geminiError: string | null = null;
    let nvidiaError: string | null = null;

    if (hasGeminiKey) {
      try {
        return await this.callGeminiWithContext(
          this.marioFreeAnswerPrompt,
          question,
          context,
        );
      } catch (error) {
        geminiError = this.describeError(error);
        this.logger.warn(`[MarioLibre] Gemini fallo: ${geminiError}`);
      }
    } else {
      geminiError = 'GOOGLE_AI_API_KEY/GEMINI_API_KEY no configurada.';
    }

    if (hasNvidiaKey) {
      try {
        return await this.callNvidiaWithContext(
          this.marioFreeAnswerPrompt,
          question,
          context,
        );
      } catch (error) {
        nvidiaError = this.describeError(error);
        this.logger.error(`[MarioLibre] NVIDIA fallo: ${nvidiaError}`);
      }
    } else {
      nvidiaError = 'NVIDIA_API_KEY no configurada.';
    }

    throw new AllAiProvidersExhaustedError(geminiError, nvidiaError);
  }

  // Llamada IA con prompt personalizado y SIN historial (clasificador, factual, reformulacion)
  private async callProvider(
    systemPrompt: string,
    userMessage: string,
    maxTokens = 350,
    temperature = 0.4,
  ): Promise<string> {
    const hasGeminiKey = !!(
      process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY
    );
    const hasNvidiaKey = !!process.env.NVIDIA_API_KEY;

    let geminiError: string | null = null;
    let nvidiaError: string | null = null;

    if (hasGeminiKey) {
      try {
        return await this.callGeminiWithContext(
          systemPrompt,
          userMessage,
          [],
          maxTokens,
          temperature,
        );
      } catch (error) {
        geminiError = this.describeError(error);
        this.logger.warn(
          `[callProvider] Gemini fallo: ${geminiError}${hasNvidiaKey ? ', intentando NVIDIA' : ''}`,
        );
      }
    } else {
      geminiError = 'GOOGLE_AI_API_KEY/GEMINI_API_KEY no configurada.';
    }

    if (hasNvidiaKey) {
      try {
        return await this.callNvidiaWithContext(
          systemPrompt,
          userMessage,
          [],
          maxTokens,
          temperature,
        );
      } catch (error) {
        nvidiaError = this.describeError(error);
        this.logger.error(`[callProvider] NVIDIA fallo: ${nvidiaError}`);
      }
    } else {
      nvidiaError = 'NVIDIA_API_KEY no configurada.';
    }

    throw new AllAiProvidersExhaustedError(geminiError, nvidiaError);
  }

  // Llamada a Gemini con prompt y contexto explícitos
  private async callGeminiWithContext(
    systemPrompt: string,
    userMessage: string,
    context: AiConversationContext[] = [],
    maxTokens = 350,
    temperature = 0.85,
  ): Promise<string> {
    const apiKey = process.env.GOOGLE_AI_API_KEY || process.env.GEMINI_API_KEY;
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

    if (!apiKey) {
      throw new InternalServerErrorException(
        'Missing GOOGLE_AI_API_KEY environment variable.',
      );
    }

    const contents = [
      ...context.flatMap((c) => [
        { role: 'user', parts: [{ text: c.userMessage }] },
        { role: 'model', parts: [{ text: c.botMessage }] },
      ]),
      { role: 'user', parts: [{ text: userMessage }] },
    ];

    let response: Response;
    try {
      response = await fetch(
        `${this.geminiApiBase}/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents,
            generationConfig: { temperature, maxOutputTokens: maxTokens },
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
      ?.map((p) => p.text)
      .filter(Boolean)
      .join('\n')
      .trim();
    const finishReason = candidate?.finishReason;

    if (!text || (finishReason && finishReason !== 'STOP')) {
      throw new InternalServerErrorException({
        message: 'Google AI response was empty or truncated.',
        finishReason,
      });
    }

    return text;
  }

  // Llamada a NVIDIA con prompt y contexto explícitos
  private async callNvidiaWithContext(
    systemPrompt: string,
    userMessage: string,
    context: AiConversationContext[] = [],
    maxTokens = 350,
    temperature = 0.85,
  ): Promise<string> {
    const apiKey = process.env.NVIDIA_API_KEY;
    const model = process.env.NVIDIA_MODEL || 'deepseek-ai/deepseek-v3.2';

    if (!apiKey) {
      throw new InternalServerErrorException(
        'Missing NVIDIA_API_KEY environment variable.',
      );
    }

    const messages = [
      { role: 'system', content: systemPrompt },
      ...context.flatMap((c) => [
        { role: 'user', content: c.userMessage },
        { role: 'assistant', content: c.botMessage },
      ]),
      { role: 'user', content: userMessage },
    ];

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
          messages,
          temperature,
          max_tokens: maxTokens,
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
    if (!text) return 'No pude generar una respuesta en este momento.';
    return text;
  }

  // Lee INDEX.md y lo cachea
  private getIndexContent(): string {
    if (this.indexContentCache !== null) return this.indexContentCache;

    const docsDir = this.resolveDocsDir();
    if (!docsDir) {
      this.indexContentCache = '';
      return '';
    }
    try {
      const indexPath = path.join(docsDir, 'INDEX.md');
      this.indexContentCache = fs.existsSync(indexPath)
        ? fs.readFileSync(indexPath, 'utf8').trim()
        : '';
    } catch {
      this.indexContentCache = '';
    }
    return this.indexContentCache;
  }

  // Lee un documento específico por nombre de archivo y lo cachea
  private getDocumentContent(filename: string): string | null {
    if (this.docsCache === null) {
      this.loadDocsCache();
    }
    return this.docsCache?.get(filename) ?? null;
  }

  private loadDocsCache(): void {
    this.docsCache = new Map();
    const docsDir = this.resolveDocsDir();
    if (!docsDir) return;
    try {
      const files = fs
        .readdirSync(docsDir)
        .filter(
          (f) =>
            f.toLowerCase().endsWith('.md') && f.toLowerCase() !== 'index.md',
        );
      for (const file of files) {
        const content = fs
          .readFileSync(path.join(docsDir, file), 'utf8')
          .trim();
        if (content) this.docsCache!.set(file, content);
      }
      this.logger.log(
        `[DocsCache] ${this.docsCache.size} documento(s) cargado(s).`,
      );
    } catch (error) {
      this.logger.error(
        `[DocsCache] Error cargando docs: ${this.describeError(error)}`,
      );
    }
  }
}
