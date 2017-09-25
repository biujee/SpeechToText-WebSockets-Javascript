import {
    AudioSourceErrorEvent,
    AudioSourceEvent,
    AudioSourceInitializingEvent,
    AudioSourceOffEvent,
    AudioSourceReadyEvent,
    AudioStreamNodeAttachedEvent,
    AudioStreamNodeAttachingEvent,
    AudioStreamNodeDetachedEvent,
    AudioStreamNodeErrorEvent,
    CreateNoDashGuid,
    Events,
    EventSource,
    IAudioSource,
    IAudioStreamNode,
    IStringDictionary,
    PlatformEvent,
    Promise,
    PromiseHelper,
    Stream,
    StreamReader,
} from "../common/Exports";

export class FileAudioSource implements IAudioSource {

    private static readonly CHUNK_SIZE: number = 8192;

    private streams: IStringDictionary<Stream<ArrayBuffer>> = {};

    private id: string;

    private events: EventSource<AudioSourceEvent>;

    private file: File;

    public constructor(file: File, audioSourceId?: string) {
        this.id = audioSourceId ? audioSourceId : CreateNoDashGuid();
        this.events = new EventSource<AudioSourceEvent>();
        this.file = file;
    }

    public TurnOn = (): Promise<boolean> => {
        if (typeof FileReader === "undefined") {
            const errorMsg = "Browser does not support FileReader.";
            this.OnEvent(new AudioSourceErrorEvent(errorMsg, "")); // initialization error - no streamid at this point
            return PromiseHelper.FromError(errorMsg);
        }

        this.OnEvent(new AudioSourceInitializingEvent(this.id)); // no stream id
        this.OnEvent(new AudioSourceReadyEvent(this.id));
        return PromiseHelper.FromResult(true);
    }

    public Id = (): string => {
        return this.id;
    }

    public Attach = (audioNodeId: string): Promise<IAudioStreamNode> => {
        this.OnEvent(new AudioStreamNodeAttachingEvent(this.id, audioNodeId));

        return this.Upload(audioNodeId).OnSuccessContinueWith<IAudioStreamNode>(
            (streamReader: StreamReader<ArrayBuffer>) => {
                this.OnEvent(new AudioStreamNodeAttachedEvent(this.id, audioNodeId));
                return {
                    Detach: () => {
                        streamReader.Close();
                        delete this.streams[audioNodeId];
                        this.OnEvent(new AudioStreamNodeDetachedEvent(this.id, audioNodeId));
                        this.TurnOff();
                    },
                    Id: () => {
                        return audioNodeId;
                    },
                    Read: () => {
                        return streamReader.Read();
                    },
                };
            });
    }

    public Detach = (audioNodeId: string): void => {
        if (audioNodeId && this.streams[audioNodeId]) {
            this.streams[audioNodeId].Close();
            delete this.streams[audioNodeId];
            this.OnEvent(new AudioStreamNodeDetachedEvent(this.id, audioNodeId));
        }
    }

    public TurnOff = (): Promise<boolean> => {
        for (const streamId in this.streams) {
            if (streamId) {
                const stream = this.streams[streamId];
                if (stream && !stream.IsClosed) {
                    stream.Close();
                }
            }
        }

        this.OnEvent(new AudioSourceOffEvent(this.id)); // no stream now
        return PromiseHelper.FromResult(true);
    }

    public get Events(): EventSource<AudioSourceEvent> {
        return this.events;
    }

    private Upload = (audioNodeId: string): Promise<StreamReader<ArrayBuffer>> => {
        return this.TurnOn()
            .OnSuccessContinueWith<StreamReader<ArrayBuffer>>((_: boolean) => {
                const stream = new Stream<ArrayBuffer>(audioNodeId);

                this.streams[audioNodeId] = stream;

                const reader: FileReader = new FileReader();

                let startOffset = 0;
                let endOffset = FileAudioSource.CHUNK_SIZE;

                reader.onload = (event: Event) => {
                    if (stream.IsClosed) {
                        return; // output stream was closed (somebody called TurnOff). We're done here.
                    }

                    stream.Write(reader.result);

                    if (endOffset < this.file.size) {
                        startOffset = endOffset;
                        endOffset = Math.min(endOffset + FileAudioSource.CHUNK_SIZE, this.file.size);
                        const chunk = this.file.slice(startOffset, endOffset);
                        reader.readAsArrayBuffer(chunk);
                    } else {
                        // we've written the entire file to the output stream, can close it now.
                        stream.Close();
                    }
                };

                reader.onerror = (event: ErrorEvent) => {
                    const errorMsg = `Error occured while processing '${this.file.name}'. ${event.error}`;
                    this.OnEvent(new AudioStreamNodeErrorEvent(this.id, audioNodeId, event.error));
                    throw new Error(errorMsg);
                };

                const chunk = this.file.slice(startOffset, endOffset);
                reader.readAsArrayBuffer(chunk);

                return stream.GetReader();
            });
    }

    private OnEvent = (event: AudioSourceEvent): void => {
        this.events.OnEvent(event);
        Events.Instance.OnEvent(event);
    }
}
