export type GaiaRef = { txid: string; outputIndex: number; sensorId?: string; createdAt: Date }

export interface OverlayStorage {
	storeRecord(txid: string, outputIndex: number, sensorId?: string): Promise<void>
	deleteRecord(txid: string, outputIndex: number): Promise<void>
	findRecentBySensor(sensorId: string, limit?: number): Promise<Array<Pick<GaiaRef, 'txid' | 'outputIndex'>>>
	findAll(limit?: number): Promise<Array<Pick<GaiaRef, 'txid' | 'outputIndex'>>>
}

// In-memory starter implementation (non-persistent; suitable for local/dev)
export class InMemoryOverlay implements OverlayStorage {
	private list: GaiaRef[] = []
	async storeRecord(txid: string, outputIndex: number, sensorId?: string) {
		this.list.unshift({ txid, outputIndex, sensorId, createdAt: new Date() })
		this.list = this.list.slice(0, 10000)
	}
	async deleteRecord(txid: string, outputIndex: number) {
		this.list = this.list.filter(r => !(r.txid === txid && r.outputIndex === outputIndex))
	}
	async findRecentBySensor(sensorId: string, limit = 100) {
		return this.list
			.filter(r => r.sensorId === sensorId)
			.slice(0, limit)
			.map(r => ({ txid: r.txid, outputIndex: r.outputIndex }))
	}
	async findAll(limit = 100) {
		return this.list
			.slice(0, limit)
			.map(r => ({ txid: r.txid, outputIndex: r.outputIndex }))
	}
}

// MongoDB implementation sketch (for future use)
/*
import type { Db, Collection } from 'mongodb'
export class MongoOverlay implements OverlayStorage {
	private readonly col: Collection<GaiaRef>
	constructor(db: Db) { this.col = db.collection<GaiaRef>('GaiaLogRecords') }
	async storeRecord(txid: string, outputIndex: number, sensorId?: string) {
		await this.col.insertOne({ txid, outputIndex, sensorId, createdAt: new Date() } as GaiaRef)
	}
	async deleteRecord(txid: string, outputIndex: number) {
		await this.col.deleteOne({ txid, outputIndex } as any)
	}
	async findRecentBySensor(sensorId: string, limit = 100) {
		return await this.col.find({ sensorId }).sort({ createdAt: -1 }).limit(limit).project({ txid: 1, outputIndex: 1, _id: 0 }).toArray() as any
	}
	async findAll(limit = 100) {
		return await this.col.find({}).sort({ createdAt: -1 }).limit(limit).project({ txid: 1, outputIndex: 1, _id: 0 }).toArray() as any
	}
}
*/





