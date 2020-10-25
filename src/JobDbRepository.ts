import * as debug from 'debug';
import {
	Collection,
	Db,
	FilterQuery,
	MongoClient,
	MongoClientOptions,
	UpdateQuery,
	ObjectId,
	SortOptionObject,
	FindOneAndUpdateOption
} from 'mongodb';
import type { Job } from './Job';
import type { Agenda } from './index';
import type { IDatabaseOptions, IDbConfig, IMongoOptions } from './types/DbOptions';
import type { IJobParameters } from './types/JobParameters';
import { hasMongoProtocol } from './utils/hasMongoProtocol';

const log = debug('agenda:db');

export class JobDbRepository {
	collection: Collection;

	constructor(
		private agenda: Agenda,
		private connectOptions: (IDatabaseOptions | IMongoOptions) & IDbConfig
	) {
		this.connectOptions.sort = this.connectOptions.sort || { nextRunAt: 1, priority: -1 };
	}

	private async createConnection(): Promise<Db> {
		const { connectOptions } = this;
		if (this.hasDatabaseConfig(connectOptions)) {
			log('using database config', connectOptions);
			return this.database(connectOptions.db.address, connectOptions.db.options);
		}

		if (this.hasMongoConnection(connectOptions)) {
			log('using passed in mongo connection');
			return connectOptions.mongo;
		}

		throw new Error('invalid db config, or db config not found');
	}

	private hasMongoConnection(connectOptions): connectOptions is IMongoOptions {
		return !!connectOptions.mongo;
	}

	private hasDatabaseConfig(connectOptions): connectOptions is IDatabaseOptions {
		return !!connectOptions.db?.address;
	}

	async getJobs(
		query: FilterQuery<IJobParameters>,
		sort: SortOptionObject<IJobParameters> = {},
		limit = 0,
		skip = 0
	): Promise<IJobParameters[]> {
		return this.collection.find(query).sort(sort).limit(limit).skip(skip).toArray();
	}

	async removeJobs(query: FilterQuery<IJobParameters>): Promise<number> {
		const result = await this.collection.deleteMany(query);
		return result.result.n || 0;
	}

	async getQueueSize(): Promise<number> {
		return this.collection.countDocuments({ nextRunAt: { $lt: new Date() } });
	}

	async unlockJob(job: Job): Promise<void> {
		await this.collection.updateOne({ _id: job.attrs._id }, { $unset: { lockedAt: true } });
	}

	/**
	 * Internal method to unlock jobs so that they can be re-run
	 */
	async unlockJobs(jobIds: ObjectId[]): Promise<void> {
		await this.collection.updateMany({ _id: { $in: jobIds } }, { $unset: { lockedAt: true } });
	}

	async lockJob(job: Job): Promise<IJobParameters | undefined> {
		// Query to run against collection to see if we need to lock it
		const criteria: FilterQuery<Omit<IJobParameters, 'lockedAt'> & { lockedAt?: Date | null }> = {
			_id: job.attrs._id,
			name: job.attrs.name,
			lockedAt: null,
			nextRunAt: job.attrs.nextRunAt,
			disabled: { $ne: true }
		};

		// Update / options for the MongoDB query
		const update: UpdateQuery<IJobParameters> = { $set: { lockedAt: new Date() } };
		const options: FindOneAndUpdateOption<IJobParameters> = { returnOriginal: false };

		// Lock the job in MongoDB!
		const resp = await this.collection.findOneAndUpdate(
			criteria as FilterQuery<IJobParameters>,
			update,
			options
		);

		return resp?.value;
	}

	async getNextJobToRun(
		jobName: string,
		nextScanAt: Date,
		lockDeadline: Date,
		now: Date = new Date()
	): Promise<IJobParameters | undefined> {
		/**
		 * Query used to find job to run
		 * @type {{$and: [*]}}
		 */
		const JOB_PROCESS_WHERE_QUERY: FilterQuery<
			Omit<IJobParameters, 'lockedAt'> & { lockedAt?: Date | null }
		> = {
			$and: [
				{
					name: jobName,
					disabled: { $ne: true }
				},
				{
					$or: [
						{
							lockedAt: { $eq: null },
							nextRunAt: { $lte: nextScanAt }
						},
						{
							lockedAt: { $lte: lockDeadline }
						}
					]
				}
			]
		};

		/**
		 * Query used to set a job as locked
		 * @type {{$set: {lockedAt: Date}}}
		 */
		const JOB_PROCESS_SET_QUERY: UpdateQuery<IJobParameters> = { $set: { lockedAt: now } };

		/**
		 * Query used to affect what gets returned
		 * @type {{returnOriginal: boolean, sort: object}}
		 */
		const JOB_RETURN_QUERY: FindOneAndUpdateOption<IJobParameters> = {
			returnOriginal: false,
			sort: this.connectOptions.sort
		};

		// Find ONE and ONLY ONE job and set the 'lockedAt' time so that job begins to be processed
		const result = await this.collection.findOneAndUpdate(
			JOB_PROCESS_WHERE_QUERY,
			JOB_PROCESS_SET_QUERY,
			JOB_RETURN_QUERY
		);

		return result.value;
	}

	async connect(): Promise<void> {
		const db = await this.createConnection();
		log('successful connection to MongoDB', db.options);

		const collection = this.connectOptions.db?.collection || 'agendaJobs';

		this.collection = db.collection(collection);
		if (log.enabled) {
			log(
				`connected with collection: ${collection}, collection size: ${
					typeof this.collection.estimatedDocumentCount === 'function'
						? await this.collection.estimatedDocumentCount()
						: '?'
				}`
			);
		}

		if (this.connectOptions.ensureIndex) {
			log('attempting index creation');
			try {
				const result = await this.collection.createIndex(
					{
						name: 1,
						...this.connectOptions.sort,
						priority: -1,
						lockedAt: 1,
						nextRunAt: 1,
						disabled: 1
					},
					{ name: 'findAndLockNextJobIndex' }
				);
				log('index succesfully created', result);
			} catch (error) {
				log('db index creation failed', error);
				throw error;
			}
		}

		this.agenda.emit('ready');
	}

	private async database(url: string, options?: MongoClientOptions) {
		let connectionString = url;

		if (!hasMongoProtocol(connectionString)) {
			connectionString = `mongodb://${connectionString}`;
		}

		const client = await MongoClient.connect(connectionString, {
			useNewUrlParser: true,
			useUnifiedTopology: true,
			...options
		});

		return client.db();
	}

	private processDbResult<DATA = unknown | void>(
		job: Job<DATA>,
		res?: IJobParameters<DATA>
	): Job<DATA> {
		log(
			'processDbResult() called with success, checking whether to process job immediately or not'
		);

		// We have a result from the above calls
		if (res) {
			// Grab ID and nextRunAt from MongoDB and store it as an attribute on Job
			// eslint-disable-next-line no-param-reassign
			job.attrs._id = res._id;
			// eslint-disable-next-line no-param-reassign
			job.attrs.nextRunAt = res.nextRunAt;

			// check if we should process the job immediately
			this.agenda.emit('processJob', job);
		}

		// Return the Job instance
		return job;
	}

	/**
	 * Save the properties on a job to MongoDB
	 * @name Agenda#saveJob
	 * @function
	 * @param {Job} job job to save into MongoDB
	 * @returns {Promise} resolves when job is saved or errors
	 */
	async saveJob<DATA = unknown | void>(job: Job<DATA>): Promise<Job<DATA>> {
		try {
			log('attempting to save a job into Agenda instance');

			// Grab information needed to save job but that we don't want to persist in MongoDB
			const id = job.attrs._id;

			// Store job as JSON and remove props we don't want to store from object
			// _id, unique, uniqueOpts
			// eslint-disable-next-line @typescript-eslint/no-unused-vars
			const { _id, unique, uniqueOpts, ...props } = {
				...job.toJson(),
				// Store name of agenda queue as last modifier in job data
				lastModifiedBy: this.agenda.attrs.name
			};

			log('[job %s] set job props: \n%O', id, props);

			// Grab current time and set default query options for MongoDB
			const now = new Date();
			const protect: Partial<IJobParameters> = {};
			let update: UpdateQuery<IJobParameters> = { $set: props };
			log('current time stored as %s', now.toISOString());

			// If the job already had an ID, then update the properties of the job
			// i.e, who last modified it, etc
			if (id) {
				// Update the job and process the resulting data'
				log('job already has _id, calling findOneAndUpdate() using _id as query');
				const result = await this.collection.findOneAndUpdate(
					{ _id: id, name: props.name },
					update,
					{ returnOriginal: false }
				);
				return this.processDbResult(job, result.value);
			}

			if (props.type === 'single') {
				// Job type set to 'single' so...
				log('job with type of "single" found');

				// If the nextRunAt time is older than the current time, "protect" that property, meaning, don't change
				// a scheduled job's next run time!
				if (props.nextRunAt && props.nextRunAt <= now) {
					log('job has a scheduled nextRunAt time, protecting that field from upsert');
					protect.nextRunAt = props.nextRunAt;
					delete (props as Partial<IJobParameters>).nextRunAt;
				}

				// If we have things to protect, set them in MongoDB using $setOnInsert
				if (Object.keys(protect).length > 0) {
					update.$setOnInsert = protect;
				}

				// Try an upsert
				log(
					`calling findOneAndUpdate(${props.name}) with job name and type of "single" as query`,
					await this.collection.findOne({
						name: props.name,
						type: 'single'
					})
				);
				// this call ensure a job of this name can only exists once
				const result = await this.collection.findOneAndUpdate(
					{
						name: props.name,
						type: 'single'
					},
					update,
					{
						upsert: true,
						returnOriginal: false
					}
				);
				log(
					`findOneAndUpdate(${props.name}) with type "single" ${
						result.lastErrorObject?.updatedExisting
							? 'updated existing entry'
							: 'inserted new entry'
					}`
				);
				return this.processDbResult(job, result.value);
			}

			if (job.attrs.unique) {
				// If we want the job to be unique, then we can upsert based on the 'unique' query object that was passed in
				const query = job.attrs.unique;
				query.name = props.name;
				if (job.attrs.uniqueOpts?.insertOnly) {
					update = { $setOnInsert: props };
				}

				// Use the 'unique' query object to find an existing job or create a new one
				log('calling findOneAndUpdate() with unique object as query: \n%O', query);
				const result = await this.collection.findOneAndUpdate(query, update, {
					upsert: true,
					returnOriginal: false
				});
				return this.processDbResult(job, result.value);
			}

			// If all else fails, the job does not exist yet so we just insert it into MongoDB
			log(
				'using default behavior, inserting new job via insertOne() with props that were set: \n%O',
				props
			);
			const result = await this.collection.insertOne(props);
			return this.processDbResult(job, result.ops[0]);
		} catch (error) {
			log('processDbResult() received an error, job was not updated/created');
			throw error;
		}
	}
}
