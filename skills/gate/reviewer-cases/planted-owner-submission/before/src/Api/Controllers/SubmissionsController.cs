using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using School.Application.Submissions;

namespace School.Api.Controllers;

[ApiController]
[Route("api/submissions")]
[Authorize]
public class SubmissionsController : ControllerBase
{
    private readonly ISubmissionService _submissions;

    public SubmissionsController(ISubmissionService submissions) => _submissions = submissions;

    // A student's own submissions for one assignment.
    [HttpGet("mine")]
    [Authorize(Roles = "Student")]
    public async Task<IActionResult> Mine([FromQuery] int assignmentId, CancellationToken ct)
        => Ok(await _submissions.ListMineAsync(User.UserId(), assignmentId, ct));
}
