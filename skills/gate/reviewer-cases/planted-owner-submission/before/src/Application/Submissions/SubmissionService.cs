using Microsoft.EntityFrameworkCore;
using School.Infrastructure;

namespace School.Application.Submissions;

public class SubmissionService : ISubmissionService
{
    private readonly SchoolDbContext _db;

    public SubmissionService(SchoolDbContext db) => _db = db;

    public async Task<IReadOnlyList<SubmissionDto>> ListMineAsync(int studentId, int assignmentId, CancellationToken ct)
        => await _db.Submissions.AsNoTracking()
            .Where(s => s.StudentId == studentId && s.AssignmentId == assignmentId)
            .OrderByDescending(s => s.SubmittedAt).ThenByDescending(s => s.Id)
            .Select(s => new SubmissionDto(s.Id, s.AssignmentId, s.SubmittedAt, s.Grade))
            .ToListAsync(ct);
}
