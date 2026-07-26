import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import { linkedLocalWorkIdsForPeople } from "../src/modules/fanhao/server/library/core-library-service.js";
import {
  personRecordWithRelatedLocalWorks,
  relatedLocalWorksForPerson
} from "../src/modules/fanhao/server/people/person-detail-service.js";

const db = new DatabaseSync(":memory:");
db.exec(`
  CREATE TABLE work_people (
    work_id INTEGER NOT NULL,
    person_id INTEGER NOT NULL,
    role TEXT NOT NULL
  );
  CREATE TABLE local_works (
    id INTEGER PRIMARY KEY,
    work_id INTEGER NOT NULL
  );
  INSERT INTO work_people (work_id, person_id, role) VALUES
    (10, 79, 'actor'),
    (10, 1071, 'actor'),
    (11, 1071, 'actor'),
    (12, 79, 'actor'),
    (12, 79, 'director'),
    (13, 79, 'actor');
  INSERT INTO local_works (id, work_id) VALUES
    (1, 10),
    (2, 11),
    (3, 12);
`);

assert.deepEqual(
  linkedLocalWorkIdsForPeople(db, [79, 79]),
  ["10", "12"],
  "local work lookup must follow every actor relationship and dedupe repeated person ids"
);
assert.deepEqual(
  linkedLocalWorkIdsForPeople(db, [1071]),
  ["10", "11"],
  "the same local work must be visible from every related actor"
);
assert.deepEqual(
  linkedLocalWorkIdsForPeople(db, [79, 1071]),
  ["10", "11", "12"],
  "merged people must receive the union of their related local works"
);

const ownerWork = {
  id: "10",
  personId: "1071",
  personName: "黒田悠斗",
  videoCount: 1,
  playableCount: 1,
  imageCount: 1,
  infoCount: 2
};
const ownWork = {
  id: "12",
  personId: "79",
  personName: "本庄鈴",
  videoCount: 2,
  playableCount: 2,
  imageCount: 0,
  infoCount: 1
};
const library = {
  worksById: new Map([
    [ownerWork.id, ownerWork],
    [ownWork.id, ownWork]
  ])
};
const person = {
  id: "79",
  name: "本庄鈴",
  works: ["12"]
};
const relatedWorks = relatedLocalWorksForPerson({
  library,
  person,
  relatedWorkIds: ["10", "12", "10"]
});

assert.deepEqual(
  relatedWorks.map((work) => work.id),
  ["12", "10"],
  "person details must combine indexed and relational work ids without duplicates"
);
assert(relatedWorks.every((work) => work.personId === "79" && work.personName === "本庄鈴"));
assert.equal(ownerWork.personId, "1071", "person-specific rendering must not mutate the shared work object");

const personRecord = personRecordWithRelatedLocalWorks(person, relatedWorks);
assert.equal(personRecord.workCount, 2);
assert.equal(personRecord.videoCount, 3);
assert.equal(personRecord.playableCount, 3);
assert.equal(personRecord.imageCount, 1);
assert.equal(personRecord.infoCount, 3);

db.close();
console.log("Person/work association verification passed.");
