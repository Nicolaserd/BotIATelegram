import { Test, TestingModule } from '@nestjs/testing';
import { IaService } from './ia.service';

type FetchMock = jest.Mock<Promise<Response>, Parameters<typeof fetch>>;

describe('IaService - Mario bot mock', () => {
  let service: IaService;
  let fetchMock: FetchMock;
  const originalFetch = global.fetch;
  const originalEnv = { ...process.env };

  const buildGeminiResponse = (text: string): Response =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        candidates: [
          {
            content: { parts: [{ text }] },
            finishReason: 'STOP',
          },
        ],
      }),
    }) as unknown as Response;

  const buildNvidiaResponse = (text: string): Response =>
    ({
      ok: true,
      status: 200,
      json: async () => ({
        choices: [{ message: { content: text } }],
      }),
    }) as unknown as Response;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.GOOGLE_AI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    delete process.env.NVIDIA_API_KEY;

    fetchMock = jest.fn() as FetchMock;
    global.fetch = fetchMock as unknown as typeof fetch;

    const module: TestingModule = await Test.createTestingModule({
      providers: [IaService],
    }).compile();

    service = module.get<IaService>(IaService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    process.env = { ...originalEnv };
    jest.restoreAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('envía el system prompt de Mario con la base de conocimiento al llamar a Gemini', async () => {
    process.env.GOOGLE_AI_API_KEY = 'fake-gemini-key';
    const fakeReply =
      'Cada dato critico debe tener un responsable definido [CARACTERIZACIÓN GOBIERNO DE DATOS.md]';
    fetchMock.mockResolvedValueOnce(buildGeminiResponse(fakeReply));

    const reply = await service.generateReply(
      '¿Quién es responsable de los datos críticos?',
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('generativelanguage.googleapis.com');

    const body = JSON.parse((init as RequestInit).body as string);
    const systemText = body.systemInstruction.parts[0].text as string;

    expect(systemText).toContain('PROMPT MAESTRO - AGENTE "MARIO"');
    expect(systemText).toContain('BASE DE CONOCIMIENTO INTERNA');
    expect(systemText).toContain('INDICE RAPIDO DE DOCUMENTOS');
    expect(systemText).toContain('CARACTERIZACIÓN GOBIERNO DE DATOS.md');
    expect(systemText).toContain('CITA SIEMPRE el archivo de origen');

    expect(reply).toBe(fakeReply);
    expect(reply).toMatch(/\[[^\]]+\.md\]/);
  });

  it('devuelve la respuesta de Mario con cita en formato [archivo.md]', async () => {
    process.env.GOOGLE_AI_API_KEY = 'fake-gemini-key';

    const turns: Array<{ question: string; mockedReply: string }> = [
      {
        question: '¿Qué es el gobierno de datos?',
        mockedReply:
          'El gobierno de datos define roles, politicas y responsabilidades para que los datos sean confiables ⚽ [MANUAL DE LINEAMIENTOS DE GOBIERNO DE DATOS.md]',
      },
      {
        question: 'háblame del catálogo y dame pizza',
        mockedReply:
          '¿Pizza? 🦭🍕 aplausos de foca... ya, ya, me concentro 😅⚽. El catalogo describe los activos de informacion de la entidad [MANUAL DE CATALOGO DE DATOS ACTUALIZADO.md]',
      },
      {
        question: '¿Qué cubre el ciclo de vida del dato?',
        mockedReply:
          'El ciclo de vida del dato cubre desde la captura hasta la disposicion final, pasando por almacenamiento y uso [MANUAL DE LINEAMIENTOS DE CICLO DE VIDA DEL DATO.md]',
      },
    ];

    // eslint-disable-next-line no-console
    console.log('\n===== Mock conversación con Mario =====');
    for (const { question, mockedReply } of turns) {
      fetchMock.mockResolvedValueOnce(buildGeminiResponse(mockedReply));
      const result = await service.generateReply(question);

      // eslint-disable-next-line no-console
      console.log(`\n👤 Usuario: ${question}`);
      // eslint-disable-next-line no-console
      console.log(`🤖 Mario:   ${result}`);

      expect(result).toBe(mockedReply);
      const citation = result.match(/\[([^\]]+\.md)\]/);
      expect(citation).not.toBeNull();
      // eslint-disable-next-line no-console
      console.log(`📎 Cita detectada: ${citation![0]}`);
      expect(citation![1].toLowerCase()).toMatch(/\.md$/);
    }
    // eslint-disable-next-line no-console
    console.log('\n========================================\n');
  });

  it('hace fallback a NVIDIA cuando Gemini falla y mantiene la cita', async () => {
    process.env.GOOGLE_AI_API_KEY = 'fake-gemini-key';
    process.env.NVIDIA_API_KEY = 'fake-nvidia-key';

    fetchMock
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: { message: 'gemini caido' } }),
      } as unknown as Response)
      .mockResolvedValueOnce(
        buildNvidiaResponse(
          'Los dominios de informacion se establecen siguiendo el procedimiento [Procedimiento para establecer Dominios de la Información.md]',
        ),
      );

    const reply = await service.generateReply('¿Cómo establezco un dominio?');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain(
      'integrate.api.nvidia.com',
    );
    expect(reply).toMatch(/\[Procedimiento para establecer Dominios.*\.md\]/);
  });

  it('usa el contexto de conversación previa en la solicitud', async () => {
    process.env.GOOGLE_AI_API_KEY = 'fake-gemini-key';
    fetchMock.mockResolvedValueOnce(
      buildGeminiResponse(
        'Sigue tu pregunta anterior, mira esto [MANUAL DE LINEAMIENTOS DE GOBIERNO DE DATOS.md]',
      ),
    );

    await service.generateReply('y entonces?', [
      {
        userMessage: 'qué es gobierno de datos',
        botMessage:
          'Es el conjunto de politicas para gestionar datos [MANUAL DE LINEAMIENTOS DE GOBIERNO DE DATOS.md]',
      },
    ]);

    const body = JSON.parse(
      fetchMock.mock.calls[0][1]!.body as string,
    );
    expect(body.contents).toHaveLength(3);
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[1].role).toBe('model');
    expect(body.contents[2].parts[0].text).toBe('y entonces?');
  });
});
