import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient } from 'mongodb';
import { MongoClient as MongoClientFour } from 'mongodb-four';
import { MongoClient as MongoClientFive } from 'mongodb-five';
import * as debug from 'debug';

const log = debug('agenda:mock-mongodb');

export interface IMockMongo {
	disconnect: () => void;
	mongo: MongoClient;
	mongod: MongoMemoryServer;
	uri: string;
}

export async function mockMongo(): Promise<IMockMongo> {

	const { MONGODB_CLIENT_VERSION = 6 } = process.env;
	const Client = {
		[4]: MongoClientFour,
		[5]: MongoClientFive,
		[6]: MongoClient
	}[MONGODB_CLIENT_VERSION] || MongoClient;
	log('using mongodb client version %s', MONGODB_CLIENT_VERSION);

	const self: IMockMongo = {} as any;
	self.mongod = await MongoMemoryServer.create();
	const uri = self.mongod.getUri();
	log('mongod started', uri);

	// @ts-ignore
	self.mongo = await Client.connect(uri);
	self.disconnect = function () {
		self.mongod.stop();
		log('mongod stopped');
		self.mongo.close();
	};
	self.uri = uri;

	return self;
}
