import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import { simpleperf_report_proto as report } from "./simpleperf/simpleperf_report";

import type { CategoryList, FrameTable, FuncTable, IndexIntoCategoryList, IndexIntoFrameTable, IndexIntoFuncTable, IndexIntoResourceTable, IndexIntoStackTable, Milliseconds, ProfileMeta, ResourceTable, SamplesTable, SerializableProfile, SerializableThread, StackTable } from './firefox-profiler/profile';
import { UniqueStringArray } from './firefox-profiler/unique-string-array';

import Long from 'long';

function toNumber(value: number | Long): number {
    if (Long.isLong(value)) {
        return value.toNumber();
    }

    return value;
}

function toMilliseconds(nanoseconds: number | Long): Milliseconds {
    return toNumber(nanoseconds) / 1000_000;
}

class Categories {
    private static categoryList: CategoryList = [];

    static readonly Other = this.createCategory("Other", "grey");
    // static readonly Native = this.createCategory("Native", "yellow");
    // static readonly JIT_JVM = this.createCategory("JIT JVM", "green");
    // static readonly Interpreted_JVM = this.createCategory("Interpreted JVM", "green");
    // static readonly ART = this.createCategory("ART", "green");
    // static readonly Kernel = this.createCategory("Kernel", "orange");

    static toJson(): CategoryList {
        return this.categoryList;
    }

    private static createCategory(name: string, color: string): IndexIntoCategoryList {
        const index = this.categoryList.length;
        this.categoryList.push({ name, color, subcategories: ['Other'] });

        return index;
    }
}

class FirefoxResourceTable {
    private resourceTable: ResourceTable = {
        length: 0,
        lib: [],
        name: [],
        host: [],
        type: [],
    };
    private resourcesMap: Map<number, IndexIntoResourceTable> = new Map();

    constructor(private strings: UniqueStringArray) {};

    toJson(): ResourceTable {
        return this.resourceTable;
    };

    findOrAddResource(file: report.IFile): IndexIntoResourceTable {
        if (!this.resourcesMap.has(file.id!)) {
            this.resourcesMap.set(file.id!, this.resourceTable.length);

            this.resourceTable.lib.push(null);
            this.resourceTable.name.push(this.strings.indexForString(file.path!));
            this.resourceTable.host.push(null);
            this.resourceTable.type.push(1);    // Library

            this.resourceTable.length++;
        }

        return this.resourcesMap.get(file.id!)!;
    }
}

class FirefoxFuncTable {
    private funcTable: FuncTable = {
        name: [],

        isJS: [],
        relevantForJS: [],

        resource: [],

        fileName: [],
        lineNumber: [],
        columnNumber: [],
      
        length: 0,
    };
    private funcMap: Map<string, IndexIntoFuncTable> = new Map();

    constructor(private strings: UniqueStringArray) {};

    toJson(): FuncTable {
        return this.funcTable;
    }

    findOrAddFunc(name: string, resourceIndex: number): IndexIntoFuncTable {
        const nameIndex = this.strings.indexForString(name);
        
        const mapKey = `${nameIndex}-${resourceIndex}`;
        if (!this.funcMap.has(mapKey)) {
            this.funcMap.set(mapKey, this.funcTable.length);

            this.funcTable.name.push(nameIndex);
            this.funcTable.isJS.push(false);
            this.funcTable.relevantForJS.push(false);
            this.funcTable.resource.push(resourceIndex);
            this.funcTable.fileName.push(null);
            this.funcTable.lineNumber.push(null);
            this.funcTable.columnNumber.push(null);

            this.funcTable.length++;
        }

        return this.funcMap.get(mapKey)!;
    }
}

class FirefoxFrameTable {
    private frameTable: FrameTable = {
        address: [],
        inlineDepth: [],

        category: [],
        subcategory: [],
        func: [],

        nativeSymbol: [],

        innerWindowID: [],

        implementation: [],
        line: [],
        column: [],

        length: 0,
    };
    private frameMap: Map<string, IndexIntoFrameTable> = new Map();

    constructor(private strings: UniqueStringArray) {};

    toJson(): FrameTable {
        return this.frameTable;
    }

    findOrAddFrame(funcIndex: IndexIntoFuncTable, category: IndexIntoCategoryList): IndexIntoFrameTable {
        const mapKey = `${funcIndex}-${category}`;

        if (!this.frameMap.has(mapKey)) {
            this.frameMap.set(mapKey, this.frameTable.length);

            this.frameTable.address.push(-1);
            this.frameTable.inlineDepth.push(0);
            this.frameTable.category.push(category);
            this.frameTable.subcategory.push(0);
            this.frameTable.func.push(funcIndex);
            this.frameTable.nativeSymbol.push(null);
            this.frameTable.innerWindowID.push(null);
            this.frameTable.implementation.push(null);
            this.frameTable.line.push(null);
            this.frameTable.column.push(null);

            this.frameTable.length++;
        }

        return this.frameMap.get(mapKey)!;
    }
}

class FirefoxSampleTable {
    private stackTable: StackTable = {
        frame: [],
        category: [],
        subcategory: [],
        prefix: [],

        length: 0,
    };
    private stackMap: Map<string, IndexIntoStackTable> = new Map();

    constructor(private strings: UniqueStringArray) {};

    toJson(): StackTable {
        return this.stackTable;
    }

    findOrAddStack(frameIndex: IndexIntoFrameTable, prefix: IndexIntoStackTable | null, category: IndexIntoCategoryList): IndexIntoStackTable {
        const mapKey = `${frameIndex}-${prefix}`;

        if (!this.stackMap.has(mapKey)) {
            this.stackMap.set(mapKey, this.stackTable.length);

            this.stackTable.frame.push(frameIndex);
            this.stackTable.category.push(category);
            this.stackTable.subcategory.push(0);
            this.stackTable.prefix.push(prefix);

            this.stackTable.length++;
        }

        return this.stackMap.get(mapKey)!;
    }
}

class FirefoxThread {
    private name: string;
    private isMainThread: boolean;

    private tid: number;
    private pid: number;

    private strings = new UniqueStringArray();

    private sampleTable: SamplesTable = {
        stack: [],
        time: [],
        weight: null,
        weightType: "samples",
        length: 0,
    };

    private stackTable: FirefoxSampleTable = new FirefoxSampleTable(this.strings);
    private frameTable: FirefoxFrameTable = new FirefoxFrameTable(this.strings);
    private funcTable: FirefoxFuncTable = new FirefoxFuncTable(this.strings);
    private resourceTable: FirefoxResourceTable = new FirefoxResourceTable(this.strings);

    private cpuClockEventId: number = -1;

    constructor(thread: report.IThread) {
        this.tid = thread.threadId!;
        this.pid = thread.processId!;

        this.isMainThread = thread.threadId === thread.processId;
        this.name = thread.threadName ?? "";
    }

    toJson(): SerializableThread {
        return {
            processType: 'default',
            processStartupTime: 0,
            processShutdownTime: null,
            registerTime: 0,
            unregisterTime: null,
            pausedRanges: [],
            name: this.name,
            isMainThread: this.isMainThread,
            // processName?: string,
            // isJsTracer?: boolean,
            pid: this.pid.toString(),
            tid: this.tid,
            samples: this.sampleTable,
            markers: {
                data: [],
                name: [],
                startTime: [],
                endTime: [],
                phase: [],
                category: [],
                length: 0,
            },
            stackTable: this.stackTable.toJson(),
            frameTable: this.frameTable.toJson(),
            // Strings for profiles are collected into a single table, and are referred to by
            // their index by other tables.
            stringArray: this.strings.serializeToArray(),
            funcTable: this.funcTable.toJson(),
            resourceTable: this.resourceTable.toJson(),
            nativeSymbols: {
                libIndex: [],
                address: [],
                name: [],
                functionSize: [],
                length: 0,
            },
        };
    }

    enableCpuClock(cpuClockEventId: number): void {
        this.cpuClockEventId = cpuClockEventId;

        this.sampleTable.weight = [];
        this.sampleTable.weightType = "tracing-ms";
    }

    addSample(sample: report.ISample, fileMap: Map<number, report.IFile>): void {
        let prefixStackId: number | null = null;
        for (const frame of sample.callchain!.reverse()) {
            const file = fileMap.get(frame.fileId!)!;

            const resourceIndex = this.resourceTable.findOrAddResource(file);
            const methodName = frame.symbolId! >= 0 ? file.symbol![frame.symbolId!] : `${path.basename(file.path!)}+0x${frame.vaddrInFile?.toString(16)}`;

            const funcIndex = this.funcTable.findOrAddFunc(methodName, resourceIndex);

            let category: IndexIntoCategoryList = Categories.Other;
            // switch (frame.executionType) {
            //     case report.Sample.CallChainEntry.ExecutionType.NATIVE_METHOD:
            //         category = Categories.Native;
            //         break;
            //     case report.Sample.CallChainEntry.ExecutionType.INTERPRETED_JVM_METHOD:
            //         category = Categories.Interpreted_JVM;
            //         break;
            //     case report.Sample.CallChainEntry.ExecutionType.JIT_JVM_METHOD:
            //         category = Categories.JIT_JVM;
            //         break;
            //     case report.Sample.CallChainEntry.ExecutionType.ART_METHOD:
            //         category = Categories.ART;
            //         break;
            // };

            const frameIndex = this.frameTable.findOrAddFrame(funcIndex, category);

            prefixStackId = this.stackTable.findOrAddStack(frameIndex, prefixStackId, category);
        };

        this.sampleTable.stack.push(prefixStackId);
        this.sampleTable.time.push(toMilliseconds(sample.time ?? 0));

        if (this.sampleTable.weight) {
            const weight = (this.cpuClockEventId >= 0 && sample.eventTypeId === this.cpuClockEventId) ? toMilliseconds(sample.eventCount ?? 0) : 0;
            this.sampleTable.weight.push(weight);
        }

        this.sampleTable.length++;
    }
}

class FirefoxProfile {
    private threads: FirefoxThread[] = [];
    private threadMap: Map<number, FirefoxThread> = new Map();

    private fileMap: Map<number, report.IFile> = new Map();

    private eventTypes: string[] | undefined;
    private cpuClockEventId: number | undefined;

    private appPackageName: string | null | undefined;
    private sampleCount: number = 0;
    private lostCount: number = 0;

    toJson(): SerializableProfile {
        return {
            meta: this.getProfileMeta(),
            libs: [],
            threads: this.threads.map(thread => thread.toJson()),
        };
    }

    getProfileMeta(): ProfileMeta {
        return {
            // The interval at which the threads are sampled.
            interval: 0,
            startTime: 0,
            processType: 0,
            categories: Categories.toJson(),
            product: this.appPackageName ?? "Android Profile",
            stackwalk: 0,
            // This is the Gecko profile format version (the unprocessed version received directly
            // from the browser.)
            version: 30,
            // This is the processed profile format version.
            preprocessedProfileVersion: 50,

            symbolicationNotSupported: true,
            markerSchema: [],

            // platform: "Android",
            // device?: string,
            importedFrom: "Simpleperf",

            // Do not distinguish between different stack types?
            usesOnlyOneStackType: true,
            // Hide the "implementation" information in the UI (see #3709)?
            doesNotUseFrameImplementation: true,
            // Hide the "Look up the function name on Searchfox" menu entry?
            sourceCodeIsNotOnSearchfox: true,
            // Extra information about the profile, not shown in the "Profile Info" panel,
            // but in the more info panel
            extra: [
                {
                    label: "Profile Information",
                    entries: [
                        {
                            label: "Sample Count",
                            format: "integer",
                            value: this.sampleCount,
                        },
                        {
                            label: "Lost Samples",
                            format: "integer",
                            value: this.lostCount,
                        }
                    ]
                }
            ],
            // Indexes of the threads that are initially visible in the UI.
            // This is useful for imported profiles for which the internal visibility score
            // ranking does not make sense.
            // initialVisibleThreads?: ThreadIndex[],
            // Indexes of the threads that are initially selected in the UI.
            // This is also most useful for imported profiles where just using the first thread
            // of each process might not make sense.
            // initialSelectedThreads?: ThreadIndex[],
            // Keep the defined thread order
            keepProfileThreadOrder: true,
        };
    }

    setMetaInfo(metaInfo: report.IMetaInfo | null | undefined) {
        this.eventTypes = metaInfo?.eventType ?? [];
        this.appPackageName = metaInfo?.appPackageName;

        this.cpuClockEventId = this.eventTypes?.indexOf("cpu-clock") ?? -1;
    }

    setLostSituation(lost: report.ILostSituation | null | undefined) {
        this.sampleCount = toNumber(lost?.sampleCount ?? 0);
        this.lostCount = toNumber(lost?.lostCount ?? 0);
    }

    addFile(file: report.IFile) {
        this.fileMap.set(file.id!, file);
    }

    addThread(thread: report.IThread) {
        const firefoxThread = new FirefoxThread(thread);
        this.threads.push(firefoxThread);
        this.threadMap.set(thread.threadId!, firefoxThread);
    }

    finalizeThreads() {
        this.threads.forEach(thread => {
            thread.enableCpuClock(this.cpuClockEventId ?? -1);
        });
    }

    addSample(sample: report.ISample): void {
        const thread = this.threadMap.get(sample.threadId!);

        if (!thread) {
            logger.warn(`Thread not found for sample: ${sample.threadId}`);
            return;
        }

        thread.addSample(sample, this.fileMap);
    }
}

export class SimpleperfReportConverter {
    private readonly magic = "SIMPLEPERF";

    private buffer: Buffer;
    private bufferOffset: number = 0;

    constructor(buffer: Buffer) {
        this.buffer = buffer;
    }

    private readUint16LE() {
        const value = this.buffer.readUInt16LE(this.bufferOffset);
        this.bufferOffset += 2;
        return value;
    }

    private readUint32LE() {
        const value = this.buffer.readUInt32LE(this.bufferOffset);
        this.bufferOffset += 4;
        return value;
    }

    private verifyMagic() {
        if (this.buffer.toString('utf8', this.bufferOffset, this.magic.length) !== this.magic) {
            throw new Error("Invalid simpleperf file");
        }
        this.bufferOffset += this.magic.length;
    }

    private readRecord(recordSize: number): report.Record {
        const recordBuffer = this.buffer.slice(this.bufferOffset, this.bufferOffset + recordSize);
        this.bufferOffset += recordSize;

        return report.Record.decode(recordBuffer);
    }

    async process() {
        this.verifyMagic();

        // Parse version
        const version = this.readUint16LE();

        let recordSize = this.readUint32LE();

        const targetProfile = new FirefoxProfile();

        const samples: report.ISample[] = [];
        let sampleCount = 0;

        while (recordSize > 0) {
            const record: report.Record = this.readRecord(recordSize);

            switch (record.recordData) {
                case "sample":
                    samples.push(record.sample!);
                    break;
                case "lost":
                    // Expected only once
                    sampleCount = toNumber(record.lost?.sampleCount ?? 0);
                    targetProfile.setLostSituation(record.lost);
                    break;
                case "file":
                    targetProfile.addFile(record.file!);
                    break;
                case "thread":
                    targetProfile.addThread(record.thread!);
                    break;
                case "metaInfo":
                    // Expected only once
                    targetProfile.setMetaInfo(record.metaInfo);
                    break;
                case "contextSwitch":
                    // Not handled
                    break;
                default:
                    logger.warn(`Unknown record type: ${record.recordData}`);
                    break;
            }

            recordSize = this.readUint32LE();
        }

        if (samples.length !== sampleCount) {
            throw new Error("Samples count doesn't match the number of samples read");
        }

        targetProfile.finalizeThreads();
        samples.forEach(sample => targetProfile.addSample(sample));

        return targetProfile.toJson();
    }
}
