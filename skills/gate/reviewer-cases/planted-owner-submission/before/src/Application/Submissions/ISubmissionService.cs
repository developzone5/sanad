namespace School.Application.Submissions;

public interface ISubmissionService
{
    Task<IReadOnlyList<SubmissionDto>> ListMineAsync(int studentId, int assignmentId, CancellationToken ct);
}
