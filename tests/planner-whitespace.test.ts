import { parseMissionPlanJson } from '../src/planner';

describe('parseMissionPlanJson whitespace handling', () => {
  it('should correctly parse valid JSON surrounded by whitespace', () => {
    const input = '{"mission": "test"}  \n\r';
    const expected = { mission: 'test' };
    expect(parseMissionPlanJson(input)).toEqual(expected);
  });
});